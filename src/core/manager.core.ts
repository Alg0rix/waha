import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppsService,
  IAppsService,
} from '@waha/apps/app_sdk/services/IAppsService';
import { EngineBootstrap } from '@waha/core/abc/EngineBootstrap';
import { GowsEngineConfigService } from '@waha/core/config/GowsEngineConfigService';
import { WebJSEngineConfigService } from '@waha/core/config/WebJSEngineConfigService';
import { WhatsappSessionGoWSCore } from '@waha/core/engines/gows/session.gows.core';
import { WebhookConductor } from '@waha/core/integrations/webhooks/WebhookConductor';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { fileExists } from '@waha/utils/files';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { complete } from '@waha/utils/reactive/complete';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
import * as fs from 'fs-extra';
import { PinoLogger } from 'nestjs-pino';
import { Observable, retry, share } from 'rxjs';
import { map } from 'rxjs/operators';

import { WhatsappConfigService } from '../config.service';
import {
  WAHAEngine,
  WAHAEvents,
  WAHASessionStatus,
} from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { populateSessionInfo, SessionManager } from './abc/manager.abc';
import { SessionParams, WhatsappSession } from './abc/session.abc';
import { EngineConfigService } from './config/EngineConfigService';
import { WhatsappSessionNoWebCore } from './engines/noweb/session.noweb.core';
import { WhatsappSessionWebJSCore } from './engines/webjs/session.webjs.core';
import { DOCS_URL } from './exceptions';
import { getProxyConfig } from './helpers.proxy';
import { MediaManager } from './media/MediaManager';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalSessionConfigRepository } from './storage/LocalSessionConfigRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';

// Multi-session support enabled - removed WAHA PLUS restriction
// export class OnlyDefaultSessionIsAllowed extends UnprocessableEntityException {
//   constructor(name: string) {
//     const encoded = Buffer.from(name, 'utf-8').toString('base64');
//     super(
//       `WAHA Core support only 'default' session. You tried to access '${name}' session (base64: ${encoded}). ` +
//         `If you want to run more then one WhatsApp account - please get WAHA PLUS version. Check this out: ${DOCS_URL}`,
//     );
//   }
// }

enum DefaultSessionStatus {
  REMOVED = undefined,
  STOPPED = null,
}

@Injectable()
export class SessionManagerCore extends SessionManager implements OnModuleInit {
  SESSION_STOP_TIMEOUT = 3000;

  // Multi-session support: Map of session name to session object
  private sessions: Map<string, WhatsappSession | DefaultSessionStatus> = new Map();
  private sessionConfigs: Map<string, SessionConfig> = new Map();
  DEFAULT = 'default';

  protected readonly EngineClass: typeof WhatsappSession;
  protected events2: DefaultMap<WAHAEvents, SwitchObservable<any>>;
  protected readonly engineBootstrap: EngineBootstrap;

  constructor(
    config: WhatsappConfigService,
    private engineConfigService: EngineConfigService,
    private webjsEngineConfigService: WebJSEngineConfigService,
    gowsConfigService: GowsEngineConfigService,
    log: PinoLogger,
    private mediaStorageFactory: MediaStorageFactory,
    @Inject(AppsService)
    appsService: IAppsService,
  ) {
    super(log, config, gowsConfigService, appsService);
    // Don't pre-initialize any sessions - they will be created on demand
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.engineBootstrap = this.getEngineBootstrap(engineName);

    this.events2 = new DefaultMap<WAHAEvents, SwitchObservable<any>>(
      (key) =>
        new SwitchObservable((obs$) => {
          return obs$.pipe(retry(), share());
        }),
    );

    this.store = new LocalStoreCore(engineName.toLowerCase());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.sessionConfigRepository = new LocalSessionConfigRepository(this.store);
    this.clearStorage().catch((error) => {
      this.log.error({ error }, 'Error while clearing storage');
    });
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else if (engine === WAHAEngine.GOWS) {
      return WhatsappSessionGoWSCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  // Multi-session support: removed session name restriction
  // private onlyDefault(name: string) {
  //   if (name !== this.DEFAULT) {
  //     throw new OnlyDefaultSessionIsAllowed(name);
  //   }
  // }

  async beforeApplicationShutdown(signal?: string) {
    // Stop all running sessions
    for (const [sessionName, session] of this.sessions.entries()) {
      if (session && typeof session !== 'undefined' && session !== null) {
        await this.stop(sessionName, true);
      }
    }
    this.stopEvents();
    await this.engineBootstrap.shutdown();
  }

  async onApplicationBootstrap() {
    await this.engineBootstrap.bootstrap();
    this.log.info('Application bootstrap - loading saved sessions...');
    // Load previously created sessions to ensure they persist across container restarts
    await this.loadSavedSessions();
    this.log.info(`Sessions map after loading saved sessions: ${this.sessions.size} sessions`);

    // Auto-start sessions based on configuration
    if (this.config.shouldRestartAllSessions) {
      this.log.info('Auto-starting all saved sessions...');
      await this.autoStartAllSessions();
    } else {
      // Only start predefined sessions if they are configured
      this.log.info('Starting predefined sessions...');
      this.startPredefinedSessions();
    }
    this.log.info(`Sessions map after startup: ${this.sessions.size} sessions`);
  }

  private async clearStorage() {
    const storage = await this.mediaStorageFactory.build(
      'all',
      this.log.logger.child({ name: 'Storage' }),
    );
    await storage.purge();
  }

  /**
   * Auto-start all saved sessions on container restart
   */
  private async autoStartAllSessions(): Promise<void> {
    const shouldFilterPreviouslyRunning = this.config.shouldRestartOnlyPreviouslyRunning;

    if (shouldFilterPreviouslyRunning) {
      this.log.info('Auto-starting only previously running sessions...');
    } else {
      this.log.info('Auto-starting all saved sessions...');
    }

    const sessionNames = Array.from(this.sessions.keys());

    let sessionsToStart: string[] = sessionNames;

    // Filter to only sessions that were running before shutdown if configured
    if (shouldFilterPreviouslyRunning) {
      const runningSessions: string[] = [];
      for (const sessionName of sessionNames) {
        if (await this.wasSessionRunning(sessionName)) {
          runningSessions.push(sessionName);
        }
      }
      sessionsToStart = runningSessions;
      this.log.info(`Found ${sessionsToStart.length} sessions that were previously running: ${sessionsToStart.join(', ')}`);

      if (sessionsToStart.length === 0) {
        this.log.info('No sessions were running before shutdown - skipping auto-start');
        return;
      }
    } else {
      this.log.info(`Found ${sessionsToStart.length} sessions to auto-start: ${sessionsToStart.join(', ')}`);

      if (sessionsToStart.length === 0) {
        this.log.info('No sessions found - skipping auto-start');
        return;
      }
    }

    // Add delay if configured
    const delaySeconds = this.config.autoStartDelaySeconds;
    if (delaySeconds > 0) {
      this.log.info(`Waiting ${delaySeconds} seconds before auto-starting sessions...`);
      await sleep(delaySeconds * 1000);
    }

    // Start sessions in parallel with some delay between each to avoid overwhelming the system
    const startPromises = sessionsToStart.map(async (sessionName, index) => {
      try {
        // Add a small delay between each session start to avoid overwhelming
        const staggerDelay = index * 2000; // 2 seconds between each session
        if (staggerDelay > 0) {
          await sleep(staggerDelay);
        }

        this.log.info(`Auto-starting session: ${sessionName}`);
        await this.start(sessionName);
        this.log.info(`Successfully auto-started session: ${sessionName}`);
      } catch (error) {
        this.log.error(`Failed to auto-start session '${sessionName}': ${error}`);
        this.log.error(error.stack);
      }
    });

    // Wait for all sessions to start (or fail)
    await Promise.all(startPromises.map(p => p.catch(e => this.log.error('Session start failed:', e))));

    const runningCount = sessionsToStart.filter(name => this.isRunning(name)).length;
    this.log.info(`Auto-start completed: ${runningCount}/${sessionsToStart.length} sessions are running`);
  }

  //
  // API Methods
  //
  async exists(name: string): Promise<boolean> {
    // Only check in-memory sessions map, ignore persistent storage
    // This ensures we don't get false positives from old session files
    this.log.debug(`Checking if session '${name}' exists...`);
    const session = this.sessions.get(name);
    this.log.debug(`Session '${name}' in map: ${session !== undefined}, value: ${session}`);

    if (session === undefined) {
      this.log.debug(`Session '${name}' does not exist - returning false`);
      return false;
    }

    const result = session !== DefaultSessionStatus.REMOVED;
    this.log.debug(`Session '${name}' exists check result: ${result}`);
    return result;
  }

  isRunning(name: string): boolean {
    const session = this.sessions.get(name);
    return !!(session && session !== DefaultSessionStatus.STOPPED && session !== DefaultSessionStatus.REMOVED);
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    this.log.debug(`UPSERT: Adding session '${name}' to sessions Map`);
    // Store the config and mark session as existing but stopped
    this.sessionConfigs.set(name, config);
    if (!this.sessions.has(name)) {
      this.sessions.set(name, DefaultSessionStatus.STOPPED);
      this.log.debug(`UPSERT: Session '${name}' added to sessions Map with STOPPED status`);
    } else {
      this.log.debug(`UPSERT: Session '${name}' already exists in sessions Map`);
    }

    // Persist session config to storage for container restart recovery
    if (config) {
      try {
        await this.sessionConfigRepository.saveConfig(name, config);
        this.log.debug(`UPSERT: Session '${name}' config saved to storage`);
      } catch (error) {
        this.log.warn(`Failed to save session config for '${name}': ${error}`);
      }
    }
  }

  /**
   * Save session running state to storage for recovery after restart
   */
  private async saveSessionRunningState(sessionName: string, isRunning: boolean): Promise<void> {
    try {
      // Create a marker file to indicate the session was running
      const sessionDir = this.store.getSessionDirectory(sessionName);
      const runningMarkerPath = `${sessionDir}/.waha.running`;

      if (isRunning) {
        // Create marker file
        await fs.ensureDir(sessionDir);
        await fs.writeFile(runningMarkerPath, Date.now().toString());
        this.log.debug(`Session '${sessionName}' marked as running`);
      } else {
        // Remove marker file
        await fs.remove(runningMarkerPath);
        this.log.debug(`Session '${sessionName}' marked as stopped`);
      }
    } catch (error) {
      this.log.warn(`Failed to save running state for session '${sessionName}': ${error}`);
    }
  }

  /**
   * Check if session was running before shutdown
   */
  private async wasSessionRunning(sessionName: string): Promise<boolean> {
    try {
      const sessionDir = this.store.getSessionDirectory(sessionName);
      const runningMarkerPath = `${sessionDir}/.waha.running`;
      return await fileExists(runningMarkerPath);
    } catch (error) {
      this.log.debug(`Could not check running state for session '${sessionName}': ${error}`);
      return false;
    }
  }

  async start(name: string): Promise<SessionDTO> {
    const existingSession = this.sessions.get(name);
    if (existingSession && existingSession !== DefaultSessionStatus.STOPPED && existingSession !== DefaultSessionStatus.REMOVED) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }
    this.log.info({ session: name }, `Starting session...`);
    const logger = this.log.logger.child({ session: name });
    const sessionConfig = this.sessionConfigs.get(name);
    logger.level = getPinoLogLevel(sessionConfig?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const storage = await this.mediaStorageFactory.build(
      name,
      loggerBuilder.child({ name: 'Storage' }),
    );
    await storage.init();
    const mediaManager = new MediaManager(
      storage,
      this.config.mimetypes,
      loggerBuilder.child({ name: 'MediaManager' }),
    );

    const webhook = new WebhookConductor(loggerBuilder);
    const proxyConfig = this.getProxyConfig(name);
    const sessionParams: SessionParams = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: sessionConfig,
    };
    if (this.EngineClass === WhatsappSessionWebJSCore) {
      sessionParams.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionGoWSCore) {
      sessionParams.engineConfig = this.gowsConfigService.getConfig();
    }
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionParams);
    this.log.debug(`START: Adding session '${name}' to sessions Map as active session`);
    this.sessions.set(name, session);
    this.updateSession(name);

    // configure webhooks
    const webhooks = this.getWebhooks(name);
    webhook.configure(session, webhooks);

    // Apps
    await this.configureApps(session);

    // Start session events monitoring for auto-restart functionality
    this.monitorSessionStatus(session);

    // start session
    await session.start();
    logger.info('Session has been started.');

    // Mark session as running for auto-restart functionality
    await this.saveSessionRunningState(name, true);

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  private updateSession(sessionName?: string) {
    // In multi-session mode, sessions manage their own events through subscribeEngineEvents2()
    // This method is kept for compatibility but doesn't need to do anything special
    // The session events are automatically populated when sessions are created
  }

  getSessionEvent(session: string, event: WAHAEvents): Observable<any> {
    const sessionObj = this.sessions.get(session);
    if (!sessionObj || sessionObj === DefaultSessionStatus.STOPPED || sessionObj === DefaultSessionStatus.REMOVED) {
      return this.events2.get(event); // Return empty observable
    }
    const whatsappSession = sessionObj as WhatsappSession;
    const observable = whatsappSession.getEventObservable(event) as Observable<any>;
    return observable.pipe(
      map(populateSessionInfo(event, whatsappSession))
    );
  }

  async stop(name: string, silent: boolean): Promise<void> {
    if (!this.isRunning(name)) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
    try {
      const session = this.getSession(name);
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info({ session: name }, `Session has been stopped.`);
    this.sessions.set(name, DefaultSessionStatus.STOPPED);
    this.updateSession();

    // Mark session as stopped for auto-restart functionality  
    await this.saveSessionRunningState(name, false);

    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async unpair(name: string) {
    const sessionObj = this.sessions.get(name);
    if (!sessionObj || sessionObj === DefaultSessionStatus.STOPPED || sessionObj === DefaultSessionStatus.REMOVED) {
      return;
    }
    const session = sessionObj as WhatsappSession;

    this.log.info({ session: name }, 'Unpairing the device from account...');
    await session.unpair().catch((err) => {
      this.log.warn(`Error while unpairing from device: ${err}`);
    });
    await sleep(1000);
  }

  async logout(name: string): Promise<void> {
    await this.sessionAuthRepository.clean(name);
  }

  async delete(name: string): Promise<void> {
    this.sessions.set(name, DefaultSessionStatus.REMOVED);
    this.updateSession();
    this.sessionConfigs.delete(name);

    // Remove running state marker
    await this.saveSessionRunningState(name, false);

    // Also remove from persistent storage
    try {
      await this.sessionConfigRepository.deleteConfig(name);
      this.log.debug(`Session '${name}' config deleted from storage`);
    } catch (error) {
      this.log.warn(`Failed to delete session config for '${name}': ${error}`);
    }
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks(sessionName: string) {
    let webhooks: WebhookConfig[] = [];
    const sessionConfig = this.sessionConfigs.get(sessionName);
    if (sessionConfig?.webhooks) {
      webhooks = webhooks.concat(sessionConfig.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }

  /**
   * Get either session's or global proxy if defined
   */
  protected getProxyConfig(sessionName: string): ProxyConfig | undefined {
    const sessionConfig = this.sessionConfigs.get(sessionName);
    if (sessionConfig?.proxy) {
      return sessionConfig.proxy;
    }
    const session = this.sessions.get(sessionName);
    if (!session || session === DefaultSessionStatus.STOPPED || session === DefaultSessionStatus.REMOVED) {
      return undefined;
    }
    const sessionsObject = {};
    for (const [name, sess] of this.sessions.entries()) {
      if (sess && sess !== DefaultSessionStatus.STOPPED && sess !== DefaultSessionStatus.REMOVED) {
        sessionsObject[name] = sess as WhatsappSession;
      }
    }
    return getProxyConfig(this.config, sessionsObject, sessionName);
  }

  getSession(name: string): WhatsappSession {
    const session = this.sessions.get(name);
    if (!session || session === DefaultSessionStatus.STOPPED || session === DefaultSessionStatus.REMOVED) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
        `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return session as WhatsappSession;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    const result: SessionInfo[] = [];

    // Handle the case where there are no sessions at all
    if (this.sessions.size === 0) {
      return result;
    }

    for (const [sessionName, session] of this.sessions.entries()) {
      if (session === DefaultSessionStatus.STOPPED && all) {
        const sessionConfig = this.sessionConfigs.get(sessionName);
        result.push({
          name: sessionName,
          status: WAHASessionStatus.STOPPED,
          config: sessionConfig,
          me: null,
        });
      } else if (session === DefaultSessionStatus.REMOVED && all) {
        // Skip removed sessions even when all=true
        continue;
      } else if (!session && !all) {
        // Skip non-existent sessions when all=false
        continue;
      } else if (session && session !== DefaultSessionStatus.STOPPED && session !== DefaultSessionStatus.REMOVED) {
        // Active session
        const whatsappSession = session as WhatsappSession;
        const me = whatsappSession?.getSessionMeInfo();
        result.push({
          name: whatsappSession.name,
          status: whatsappSession.status,
          config: whatsappSession.sessionConfig,
          me: me,
        });
      }
    }

    return result;
  }

  private async fetchEngineInfo(sessionName: string) {
    const sessionObj = this.sessions.get(sessionName);
    if (!sessionObj || sessionObj === DefaultSessionStatus.STOPPED || sessionObj === DefaultSessionStatus.REMOVED) {
      return { engine: null };
    }
    const session = sessionObj as WhatsappSession;
    // Get engine info
    let engineInfo = {};
    if (session) {
      try {
        engineInfo = await promiseTimeout(1000, session.getEngineInfo());
      } catch (error) {
        this.log.debug(
          { session: session.name, error: `${error}` },
          'Can not get engine info',
        );
      }
    }
    const engine = {
      engine: session?.engine,
      ...engineInfo,
    };
    return engine;
  }

  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    const sessions = await this.getSessions(true);
    const session = sessions.find(s => s.name === name);
    if (!session) {
      return null;
    }
    const engine = await this.fetchEngineInfo(name);
    return { ...session, engine: engine };
  }

  protected stopEvents() {
    complete(this.events2);
  }

  async onModuleInit() {
    await this.init();
  }

  async init() {
    await this.store.init();
    const knex = this.store.getWAHADatabase();
    await this.appsService.migrate(knex);
  }

  /**
   * Clear all session data for debugging multi-session issues
   */
  async clearAllSessions(): Promise<void> {
    this.log.info(`Clearing all session data - current sessions count: ${this.sessions.size}`);

    // Clear in-memory maps
    this.sessions.clear();
    this.sessionConfigs.clear();
    this.log.info(`In-memory maps cleared - sessions: ${this.sessions.size}, configs: ${this.sessionConfigs.size}`);

    // Clear session directories and configs
    try {
      const allConfigs = await this.sessionConfigRepository.getAllConfigs();
      this.log.info(`Found ${allConfigs.length} session configs to clear`);
      for (const sessionName of allConfigs) {
        this.log.info(`Removing session directory for: ${sessionName}`);
        await this.sessionConfigRepository.deleteConfig(sessionName);
      }
    } catch (error) {
      this.log.warn('Error clearing session configs:', error);
    }

    this.log.info('All session data cleared');
  }

  /**
   * Load saved sessions from storage to restore state after container restart
   */
  async loadSavedSessions(): Promise<void> {
    this.log.info('Loading saved sessions from storage...');

    try {
      // Ensure storage is initialized first
      await this.store.init();

      // Get all session directories that exist in storage
      const savedSessionNames = await this.sessionConfigRepository.getAllConfigs();
      this.log.info(`Found ${savedSessionNames.length} saved session directories`);

      for (const sessionName of savedSessionNames) {
        try {
          // Load session config if it exists
          const sessionConfig = await this.sessionConfigRepository.getConfig(sessionName);

          if (sessionConfig) {
            this.log.info(`Loading session '${sessionName}' with config`);
            this.sessionConfigs.set(sessionName, sessionConfig);
          } else {
            this.log.info(`Loading session '${sessionName}' without config`);
          }

          // Mark session as stopped - it will be manually started when needed
          this.sessions.set(sessionName, DefaultSessionStatus.STOPPED);
          this.log.debug(`Session '${sessionName}' loaded and marked as STOPPED`);
        } catch (error) {
          this.log.warn(`Failed to load session '${sessionName}': ${error}`);
        }
      }

      this.log.info(`Successfully loaded ${this.sessions.size} sessions from storage`);
    } catch (error) {
      this.log.warn(`Error loading saved sessions: ${error}`);
      // If we can't load saved sessions, start with clean state
      this.sessions.clear();
      this.sessionConfigs.clear();
    }
  }

  /**
   * Monitor session status changes to handle failures and update running state
   */
  private monitorSessionStatus(session: WhatsappSession): void {
    try {
      // Subscribe to session status events
      const statusObservable = session.getEventObservable(WAHAEvents.SESSION_STATUS) as Observable<any>;
      statusObservable.subscribe(
        (statusEvent: any) => {
          this.handleSessionStatusChange(session.name, statusEvent);
        },
        (error) => {
          this.log.warn(`Error monitoring session status for '${session.name}': ${error}`);
        }
      );
    } catch (error) {
      this.log.warn(`Failed to set up session status monitoring for '${session.name}': ${error}`);
    }
  }

  /**
   * Handle session status changes for auto-restart functionality
   */
  private async handleSessionStatusChange(sessionName: string, statusEvent: any): Promise<void> {
    try {
      const status = statusEvent.status || statusEvent;
      this.log.debug(`Session '${sessionName}' status changed to: ${status}`);

      // If session fails, mark it as not running
      if (status === WAHASessionStatus.FAILED) {
        this.log.warn(`Session '${sessionName}' failed, marking as not running`);
        await this.saveSessionRunningState(sessionName, false);
      }
      // If session is working, ensure it's marked as running
      else if (status === WAHASessionStatus.WORKING) {
        this.log.debug(`Session '${sessionName}' is working, ensuring it's marked as running`);
        await this.saveSessionRunningState(sessionName, true);
      }
      // If session is stopped, mark as not running
      else if (status === WAHASessionStatus.STOPPED) {
        this.log.debug(`Session '${sessionName}' stopped, marking as not running`);
        await this.saveSessionRunningState(sessionName, false);
      }
    } catch (error) {
      this.log.warn(`Error handling status change for session '${sessionName}': ${error}`);
    }
  }
}
