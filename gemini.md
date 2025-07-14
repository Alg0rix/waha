# Project Overview

This project is a Waha (WhatsApp HTTP API) application. It appears to be a NestJS project written in TypeScript.

# Setup Instructions

To set up this project, you would typically follow these steps:

1.  **Install dependencies:** `yarn install` or `npm install`
2.  **Build the project:** `yarn build` or `npm run build`
3.  **Run the application:** `yarn start` or `npm start`

# Common Commands

-   **Run tests:** Look for `test` scripts in `package.json` (e.g., `yarn test`)
-   **Linting:** Look for `lint` scripts in `package.json` (e.g., `yarn lint`)
-   **Formatting:** Look for `format` scripts in `package.json` (e.g., `yarn format`)

# Important Notes for Gemini

-   When modifying code, adhere to the existing TypeScript conventions and NestJS patterns.
-   Always check `package.json` for available scripts before attempting to run commands like `test`, `lint`, or `build`.
-   Be mindful of the `.env.example` file for environment variable configurations.

## Git Ignore

The `.gitignore` file specifies intentionally untracked files that Git should ignore. This project's `.gitignore` includes common exclusions like:

-   Compiled output (`/dist`, `/node_modules`)
-   Logs (`*.log`)
-   OS-specific files (`.DS_Store`)
-   IDE and editor configurations (`.idea`, `.vscode`)
-   Sensitive files (`.env`, `.secrets`)
-   Session and media files (`sessions`, `media`)

## Docker Compose

The `docker-compose.yaml` file defines the services, networks, and volumes for the application's Docker environment. Key aspects include:

-   **`waha` service:** This is the main application service, built from the local Dockerfile. It exposes port `3000` and mounts `./sessions` and `./media` as volumes for persistent data.
-   **DNS configuration:** Specifies DNS servers for resolving `web.whatsapp.com`.
-   **Logging:** Configures logging to `json-file` with size and file limits.
-   **Optional services:** The file contains commented-out configurations for:
    -   `postgres`: For PostgreSQL database to save sessions.
    -   `mongodb`: For MongoDB database to save sessions.
    -   `minio`: For S3-compatible storage (MinIO) to save media files.

## Package.json

The `package.json` file defines the project's metadata, scripts, and dependencies. Key sections include:

-   **`scripts`**: This section defines various commands that can be run using `yarn run` (or `npm run`). Notable scripts include:
    -   `build`: Compiles the TypeScript code.
    -   `start`: Starts the application in various modes (`start:dev`, `start:debug`, `start:prod`).
    -   `lint`: Lints the TypeScript code for style and error checking.
    -   `test`: Runs unit and e2e tests.
    -   `gows:proto`: Scripts related to Google Web Services (GWS) protobufs.
-   **`dependencies`**: Lists the production dependencies required for the application to run. This includes `@adiwajshing/baileys` (a WhatsApp library), `@nestjs/*` packages (NestJS framework), various AWS SDK components, BullMQ for job queues, and other utilities.
-   **`devDependencies`**: Lists the development dependencies, such as `@nestjs/cli`, `@nestjs/testing`, `jest` for testing, `typescript`, and `eslint`.
-   **`resolutions`**: Specifies exact versions for transitive dependencies to avoid conflicts.
