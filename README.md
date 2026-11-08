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
