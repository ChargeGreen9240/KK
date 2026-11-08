# Charge Green OCPP connection test

OCPP 1.6J connection-test backend for a single charger. This is a test service, not a production charging manager.

## Runtime configuration (Render secrets only)
- CHARGER_ID: charger identity
- CHARGER_KEY: unique alphanumeric password, 16–40 characters
- ADMIN_KEY: separate bearer token, at least 24 characters

Charger connects with TLS to `/ocpp/<Charger ID>`, WebSocket subprotocol `ocpp1.6`, and HTTP Basic authentication (username = Charger ID, password = Authorization Key).

FoxSwitch may append Charger ID to the configured URL. Verify this during commissioning. Do not duplicate the ID if appended automatically.

API: GET /health (public health only), GET /api/status, POST /api/start, POST /api/stop. All /api routes require the server-side admin bearer token. Never put it in browser JavaScript. Start requires a car connected and charger status Preparing. Server test idTag: ChargeGreenTest. Other RFID tags are rejected during commissioning.

No automatic charge commands on startup. No pricing, scheduling, current limits, billing or persistent history. State is in memory and lost on restart. A running charge is not automatically stopped on backend failure. After restart, transaction information must be recovered from charger MeterValues before remote stop is available. Charger hardware limits remain authoritative.

Deploy in Frankfurt using npm ci and npm start. Free Render hosting is only for supervised tests, can sleep and has no uptime guarantee. Continuous unattended charging requires durable state, tested restart recovery and always-on hosting.

Run npm test before deployment. Never commit keys, precise customer data or live credentials.

## Pilot app integration
The authenticated Site now stores settings, draft/active plans, events and measured sessions in D1. Configure SITE_URL, EVENT_KEY and SITE_ACCESS_KEY in Render secrets; the access key bypasses only the private Site gate, and EVENT_KEY authorizes the narrowly scoped service endpoints. ADMIN_KEY is internal to the Site proxy. Charger credentials stay unchanged.

CHARGER_COMMISSIONED=true and SERVER_ALWAYS_ON=true are both required before automatic schedules can be activated. They remain false on the free pilot service. Never set these until physical commissioning and continuous hosting are verified. A restarted backend marks an old active plan failed instead of silently resuming. The user must review and reactivate it. Failure alerts are displayed inside the app; no external push is configured.

Session starts require a successful persistence write before acceptance; their OCPP request identity is stored to make retries idempotent. Stop commands remain available when history storage fails, although the charger must still be connected and its transaction known. There is no durable local outbox on the free service: delayed event delivery during a complete Site outage may need charger retries. This remains a supervised pilot until recovery and charging profiles are validated on the physical device.
