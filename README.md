# Claimbase Community Edition

Claimbase Community Edition is a self-hostable expense claim tracker with a Telegram-first workflow and a lightweight web portal.

It is designed for developers, small teams, and self-hosters who want a clean base for receipt and claim management without the full commercial feature set.

## What is included

- Telegram bot for simple onboarding
- Web portal for receipt and claim management
- Manual receipt entry
- Flat receipt list
- Basic claim overview
- PostgreSQL-backed architecture
- Self-hostable monorepo setup

## What is not included in Community Edition

The community edition intentionally excludes advanced commercial workflows.

Not included here:

- AI-powered receipt parsing
- PDF and Excel claim generation
- Advanced claim review workflows
- Automated reminders and scheduling
- Advanced dashboard analytics
- Bulk upload workflows
- Richer production automation

## Who this is for

Claimbase Community Edition is suitable for:

- developers exploring Telegram-first internal tools
- self-hosters who want a claim-tracking base to extend
- small teams that are comfortable with manual receipt entry
- technical users who want an open-core starting point

## Project structure

- `artifacts/api-server/` - API server and Telegram bot
- `artifacts/web-portal/` - React web portal
- `lib/db/` - database schema and DB package
- `lib/api-spec/` - OpenAPI spec
- `lib/api-client-react/` - generated React API client
- `lib/api-zod/` - generated Zod schemas

## Quick start

### Requirements

- Node.js 22+
- pnpm
- PostgreSQL

### Install

Run package installation with pnpm.

### Configure

Create a `.env` file in the project root with the variables needed for local development.

### Database

Change into `lib/db` and run the schema push command.

### Run

Use the workspace scripts to start the API server and web portal locally.

## Community vs Pro

Claimbase Community Edition provides the self-hostable foundation.

Claimbase Pro adds the commercial workflows and premium UX, including AI receipt parsing, richer claim generation, automation, and more advanced reporting.

## License

This repository is released under a source-available license. See `LICENSE` for details.

## Status

This repository is the community edition and is intended to remain useful, understandable, and extensible, while keeping advanced commercial functionality out of scope.
