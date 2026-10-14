# trellouploader

An Express service for backing up Trello data to Google Drive.

The current source defines `POST /api/login` and `GET /api/backup` routes. The service depends on Trello and Google API credentials and a target Drive folder. Check the source for the exact configuration required by this revision.

## Run locally

Install dependencies with `npm install` and start the service with `npm start`. Configure credentials through the private environment or deployment configuration used by the application. Never commit tokens, credentials, or private configuration files.

Review the current implementation and verify its authentication, backup behavior, and deployment requirements before using it with real data.
