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
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
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
import { getProxyConfig } from './helpers.proxy';
import { MediaManager } from './media/MediaManager';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalSessionConfigRepository } from './storage/LocalSessionConfigRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';

@Injectable()
export class SessionManagerCore extends SessionManager implements OnModuleInit {
  SESSION_STOP_TIMEOUT = 3000;

  private readonly sessions = new Map<string, WhatsappSession>();
  private readonly sessionConfigs = new Map<string, SessionConfig | undefined>();

  protected readonly EngineClass: typeof WhatsappSession;
  protected sessionEvents: DefaultMap<
    string,
    DefaultMap<WAHAEvents, SwitchObservable<any>>
  >;
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
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.engineBootstrap = this.getEngineBootstrap(engineName);

    this.sessionEvents = new DefaultMap<
      string,
      DefaultMap<WAHAEvents, SwitchObservable<any>>
    >(
      () =>
        new DefaultMap<WAHAEvents, SwitchObservable<any>>(
          () =>
            new SwitchObservable((obs$) => {
              return obs$.pipe(retry(), share());
            }),
        ),
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

  async beforeApplicationShutdown(signal?: string) {
    for (const sessionName of Array.from(this.sessions.keys())) {
      await this.stop(sessionName, true);
    }
    this.stopEvents();
    await this.engineBootstrap.shutdown();
  }

  async onApplicationBootstrap() {
    await this.engineBootstrap.bootstrap();
    this.startPredefinedSessions();
  }

  private async clearStorage() {
    const storage = await this.mediaStorageFactory.build(
      'all',
      this.log.logger.child({ name: 'Storage' }),
    );
    await storage.purge();
  }

  private getSessionConfig(name: string): SessionConfig | undefined {
    return this.sessionConfigs.get(name);
  }

  private async setSessionConfig(name: string, config?: SessionConfig) {
    this.sessionConfigs.set(name, config);
    if (this.sessionConfigRepository) {
      const persistedConfig: SessionConfig = config ?? ({} as SessionConfig);
      await this.sessionConfigRepository.saveConfig(name, persistedConfig);
    }
  }

  private async removeSessionConfig(name: string) {
    this.sessionConfigs.delete(name);
    await this.sessionConfigRepository?.deleteConfig(name);
  }

  private async loadSavedSessionConfigs() {
    if (!this.sessionConfigRepository) {
      return;
    }
    const sessionNames = await this.sessionConfigRepository.getAllConfigs();
    for (const sessionName of sessionNames) {
      const config =
        (await this.sessionConfigRepository.getConfig(sessionName)) ?? undefined;
      this.sessionConfigs.set(sessionName, config);
    }
  }

  protected startPredefinedSessions() {
    const sessionsToStart = new Set<string>();
    for (const name of this.config.startSessions) {
      if (name) {
        sessionsToStart.add(name);
      }
    }

    const shouldRestartSavedSessions =
      this.config.shouldRestartAllSessions ||
      this.config.shouldRestartWorkerSessions;
    if (shouldRestartSavedSessions && this.sessionConfigs.size > 0) {
      for (const name of this.sessionConfigs.keys()) {
        sessionsToStart.add(name);
      }
    }

    if (!sessionsToStart.size) {
      return;
    }

    const delayMs = this.config.autoStartDelaySeconds * 1000;
    for (const sessionName of sessionsToStart) {
      this.withLock(sessionName, async () => {
        const log = this.log.logger.child({ session: sessionName });
        log.info(`Restarting PREDEFINED session...`);
        await this.start(sessionName).catch((error) => {
          log.error(`Failed to start PREDEFINED session: ${error}`);
          log.error(error.stack);
        });
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      });
    }
  }

  private getRunningSessionsRecord(): Record<string, WhatsappSession> {
    const result: Record<string, WhatsappSession> = {};
    for (const [sessionName, session] of this.sessions.entries()) {
      result[sessionName] = session;
    }
    return result;
  }

  private updateSessionEvents(session: WhatsappSession) {
    const sessionEventMap = this.sessionEvents.get(session.name);
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      const stream$ = session
        .getEventObservable(event)
        .pipe(map(populateSessionInfo(event, session)));
      sessionEventMap.get(event).switch(stream$);
    }
  }

  private resetSessionEvents(name: string) {
    const sessionEventMap = this.sessionEvents.get(name);
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      sessionEventMap.get(event).switch(undefined);
    }
  }

  //
  // API Methods
  //
  async exists(name: string): Promise<boolean> {
    return this.sessions.has(name) || this.sessionConfigs.has(name);
  }

  isRunning(name: string): boolean {
    return this.sessions.has(name);
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    await this.setSessionConfig(name, config);
  }

  async start(name: string): Promise<SessionDTO> {
    if (this.sessions.has(name)) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }
    this.log.info({ session: name }, `Starting session...`);
    const config = this.getSessionConfig(name);
    const logger = this.log.logger.child({ session: name });
    logger.level = getPinoLogLevel(config?.debug);
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
    const proxyConfig = this.getProxyConfig(name, config);
    const sessionConfig: SessionParams = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: config,
      ignore: this.ignoreChatsConfig(config),
    };
    if (this.EngineClass === WhatsappSessionWebJSCore) {
      sessionConfig.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionGoWSCore) {
      sessionConfig.engineConfig = this.gowsConfigService.getConfig();
    }
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionConfig);
    this.sessions.set(name, session);
    this.updateSessionEvents(session);

    // configure webhooks
    const webhooks = this.getWebhooks(config);
    webhook.configure(session, webhooks);

    // Apps
    await this.appsService.beforeSessionStart(session, this.store);

    // start session
    await session.start();
    logger.info('Session has been started.');

    // Apps
    await this.appsService.afterSessionStart(session, this.store);

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  getSessionEvent(session: string, event: WAHAEvents): Observable<any> {
    return this.sessionEvents.get(session).get(event);
  }

  async stop(name: string, silent: boolean): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
    try {
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info({ session: name }, `Session has been stopped.`);
    this.sessions.delete(name);
    this.resetSessionEvents(name);
    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async unpair(name: string) {
    const session = this.sessions.get(name);
    if (!session) {
      return;
    }

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
    this.sessions.delete(name);
    this.resetSessionEvents(name);
    await this.removeSessionConfig(name);
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks(config?: SessionConfig) {
    let webhooks: WebhookConfig[] = [];
    if (config?.webhooks) {
      webhooks = webhooks.concat(config.webhooks);
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
  protected getProxyConfig(
    name: string,
    config?: SessionConfig,
  ): ProxyConfig | undefined {
    if (config?.proxy) {
      return config.proxy;
    }
    const session = this.sessions.get(name);
    if (!session) {
      return undefined;
    }
    const sessions = this.getRunningSessionsRecord();
    return getProxyConfig(this.config, sessions, name);
  }

  getSession(name: string): WhatsappSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return session;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    const infos: SessionInfo[] = [];
    const knownNames = new Set<string>([
      ...this.sessionConfigs.keys(),
      ...this.sessions.keys(),
    ]);

    for (const name of knownNames) {
      const session = this.sessions.get(name);
      if (!session) {
        if (!all) {
          continue;
        }
        infos.push({
          name,
          status: WAHASessionStatus.STOPPED,
          config: this.getSessionConfig(name),
          me: null,
          presence: null,
          timestamps: {
            activity: null,
          },
        });
        continue;
      }
      const me = session.getSessionMeInfo();
      infos.push({
        name: session.name,
        status: session.status,
        config: session.sessionConfig,
        me: me,
        presence: session.presence,
        timestamps: {
          activity: session.getLastActivityTimestamp(),
        },
      });
    }

    if (!all && infos.length === 0) {
      return [];
    }

    return infos;
  }

  private async fetchEngineInfo(session?: WhatsappSession) {
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
    const session = this.sessions.get(name);
    const config = this.getSessionConfig(name);
    if (!session && !config) {
      return null;
    }
    let info: SessionInfo;
    if (session) {
      const me = session.getSessionMeInfo();
      info = {
        name: session.name,
        status: session.status,
        config: session.sessionConfig,
        me,
        presence: session.presence,
        timestamps: {
          activity: session.getLastActivityTimestamp(),
        },
      };
    } else {
      info = {
        name,
        status: WAHASessionStatus.STOPPED,
        config,
        me: null,
        presence: null,
        timestamps: {
          activity: null,
        },
      };
    }
    const engine = await this.fetchEngineInfo(session);
    return {
      ...info,
      engine: engine,
    };
  }

  protected stopEvents() {
    for (const events of this.sessionEvents.values()) {
      for (const stream of events.values()) {
        stream.complete();
      }
    }
  }

  async onModuleInit() {
    await this.init();
  }

  async init() {
    await this.store.init();
    await this.sessionConfigRepository?.init();
    await this.loadSavedSessionConfigs();
    const knex = this.store.getWAHADatabase();
    await this.appsService.migrate(knex);
  }
}
