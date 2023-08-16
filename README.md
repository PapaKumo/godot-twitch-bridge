# What is this?

This is an early prototype of a Twitch integrated webserver which we can later use to control a game.

The idea is that by building the Twitch integration as a webserver, we can [expose data to Godot](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html#calling-javascript-from-script) via its [JavaScriptBridge](https://docs.godotengine.org/en/stable/classes/class_javascriptbridge.html).

Or maybe by using [WebSockets](https://docs.godotengine.org/en/stable/tutorials/networking/websocket.html).

Hopefully this makes it easier to develop the game and the Twitch integration separately and concurrently.

# Installation

## Requirements

- Node 18.16.1

  - I recommend using [nvm-windows](https://github.com/coreybutler/nvm-windows) if you're on Windows.

- [Git BASH](https://gitforwindows.org/) or another shell.

## Installation Steps

1. Clone the repository. Use GitHub Desktop if you're lazy.

2. Open your shell and navigate to the project folder.

3. Install dependencies.

   ```bash
   npm install
   ```

4. Proceed to [Configuring the Server](#configuring-the-server).

# Configuring the Server

Necessary steps before running the server.

- Copy `./config/server.sample.yaml` to `./config/server.yaml`

- You will need a Twitch API clientId and clientSecret from https://dev.twitch.tv/console

  - In the Twitch Developer Console, create a new application.

  - Set the OAuth Redirect URL to `http://localhost:13371/twitch/auth-callback`

  - Set the Category to "Game Integration".

  - Copy/paste your client ID and client secret into the `./config/server.yaml` file.

- For the `bot` user, while testing you can use your own Twitch account and channel to chat in.

  ```yaml
  bot:
    user: papakumo
    channel: papakumo
  ```

  - We will need to get an access token for the bot. We will do this by running the server.

# Running the Server

These instructions assume you have a Bash shell (e.g. [Git BASH](https://gitforwindows.org/) included with git for Windows), but other shells may work.

- From the project folder:

  ```bash
  npm run start
  ```

- Then open a browser to http://localhost:13371/twitch/auth

- Follow the prompts to authorize Twitch. You should be logged in as the user you intend to use as the bot.

- On success, the webpage will display `"welcome <username>"`, and the shell should print `Bot created.`

- Now, you should be able to chat in your Twitch channel and see the bot user log the message.

  ```
  Creating bot... papakumo
  Bot created.
  pomatomaster used: ~left
  PapaKumo used: ~shoot
  pomatomaster used: ~right
  ```

- You can stop the server with `Ctrl+C`.
