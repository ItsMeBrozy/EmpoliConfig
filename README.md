# Activity Check Discord Bot

A powerful Discord bot that automatically sends activity check pings at customizable intervals.

## Features
- **!activitycheck-setup [time]**: Set up an automatic message (e.g., `1 minute`, `1 hour`).
- **!activitycheck-stop**: Stop the check in the current channel.
- **Uptime Ready**: Includes an Express server for keep-alive services.
- **Hardened Networking**: Optimized for stability on cloud hosting platforms.

## Setup
1. Clone this repository.
2. Run `npm install`.
3. Set your `DISCORD_TOKEN` in your environment variables.
4. Run `npm start`.

## Commands
| Command | Description |
| --- | --- |
| `!activitycheck-setup [time]` | Starts an activity check every X minutes/hours. |
| `!activitycheck-stop` | Stops the active check in that channel. |
