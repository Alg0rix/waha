# Auto-Restart Sessions Feature

This feature enables automatic restart of WhatsApp sessions when the container or application restarts.

## How it Works

1. **Session State Tracking**: When a session starts, a marker file `.waha.running` is created in the session directory
2. **Session State Cleanup**: When a session stops, the marker file is removed
3. **Auto-Start on Restart**: During application bootstrap, the system checks for sessions that have running markers and automatically starts them

## Configuration

### Environment Variables

- `WHATSAPP_RESTART_ALL_SESSIONS=true` - Enable auto-restart of sessions on container restart
- `WHATSAPP_RESTART_ONLY_PREVIOUSLY_RUNNING=true` - Only restart sessions that were running before shutdown (default: false, starts all sessions)
- `WAHA_AUTO_START_DELAY_SECONDS=10` - Delay in seconds before starting sessions (default: 0)

### Session Staggering

To avoid overwhelming the system, sessions are started with a 2-second delay between each session.

## Usage Examples

### Docker Compose

```yaml
services:
  waha:
    image: devlikeapro/waha
    environment:
      - WHATSAPP_RESTART_ALL_SESSIONS=true
      # Optional: Only restart previously running sessions
      # - WHATSAPP_RESTART_ONLY_PREVIOUSLY_RUNNING=true
      - WAHA_AUTO_START_DELAY_SECONDS=10
    volumes:
      - ./sessions:/app/sessions
```

### Docker Run

```bash
docker run \
  -e WHATSAPP_RESTART_ALL_SESSIONS=true \
  -e WAHA_AUTO_START_DELAY_SECONDS=10 \
  -v ./sessions:/app/sessions \
  devlikeapro/waha

# Or to only restart previously running sessions:
docker run \
  -e WHATSAPP_RESTART_ALL_SESSIONS=true \
  -e WHATSAPP_RESTART_ONLY_PREVIOUSLY_RUNNING=true \
  -e WAHA_AUTO_START_DELAY_SECONDS=10 \
  -v ./sessions:/app/sessions \
  devlikeapro/waha
```

## Behavior

1. **First Start**: No sessions will auto-start as none were previously running
2. **After Starting Sessions**: Create and start sessions through the API
3. **Container Restart**: All previously running sessions will automatically start
4. **Graceful Shutdown**: Sessions are properly marked as stopped
5. **Session Deletion**: Running markers are cleaned up when sessions are deleted

## Logs

The feature provides detailed logging:

```
[SessionManagerCore] Auto-starting previously running sessions...
[SessionManagerCore] Found 2 sessions that were previously running: session1, session2
[SessionManagerCore] Waiting 10 seconds before auto-starting sessions...
[SessionManagerCore] Auto-starting session: session1
[SessionManagerCore] Successfully auto-started session: session1
[SessionManagerCore] Auto-starting session: session2
[SessionManagerCore] Successfully auto-started session: session2
[SessionManagerCore] Auto-start completed: 2/2 sessions are running
```

## Files Created

- `{session_directory}/.waha.running` - Marker file indicating session was running
- Contains timestamp of when the session was marked as running

## Fallback Behavior

- If `WHATSAPP_RESTART_ALL_SESSIONS=false` or not set, only predefined sessions from `WHATSAPP_START_SESSION` will start
- If session fails to start, it's logged but doesn't prevent other sessions from starting
- Sessions that fail to start can be manually restarted through the API

## Compatibility

This feature is compatible with:
- Multi-session support
- All WhatsApp engines (WEBJS, NOWEB, GOWS)
- Existing session management APIs
- Docker containers and manual deployments
