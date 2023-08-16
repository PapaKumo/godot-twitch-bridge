import express from "express";
import http from "http";
import path from "path";
import {Server as ioServer} from "socket.io";
import crypto from "crypto";
import yaml from "yaml";
import fs from "fs/promises";
import {AccessToken, RefreshingAuthProvider} from "@twurple/auth";
import {ApiClient, HelixUser} from "@twurple/api";
import {Bot, createBotCommand} from "@twurple/easy-bot";
import {getDirName} from "./util.mts";

/** The working directory of the server. */
const WORKING_DIRECTORY = process.cwd();

/**
 * A valid server config.
 */
export type ServerConfig = {
	twitch: {
		clientId: string;
		clientSecret: string;
	};
	bot: {
		user: string;
		channel: string;
	};
	port: number;
	hostName: string;
};

/**
 * The server.
 * Currently a simple express server with a twitch auth flow.
 */
export class Server {
	/** How long a twitch auth request is valid for. */
	static readonly DEFAULT_TWITCH_AUTH_TIMEOUT = 1000 * 60 * 5;

	/** The port to listen on. */
	protected port = 13371;

	/** The hostname to listen on. */
	protected hostName = "localhost";

	/** The fully qualified hostname as it appears in URLs. */
	protected fullyQualifiedHostName: string;

	/** The express server. */
	protected express = express();

	/** The http server. */
	protected http = http.createServer(this.express);

	/** The socket.io server. Not used yet, but may come in handy. */
	protected io = new ioServer(this.http);

	/** The twitch config. */
	protected twitchConfig: ServerConfig["twitch"];

	/** The bot config. */
	protected botConfig: ServerConfig["bot"];

	/**
	 * The twitch auth state. Secret keys are added when a user starts the auth flow.
	 * The secret keys are used to verify whether the subsequent auth callback is legit.
	 * Each key is automatically removed after DEFAULT_TWITCH_AUTH_TIMEOUT
	 */
	protected twitchAuthState: {[twitchStateKey: string]: NodeJS.Timeout} = {};

	/** The twitch auth provider. Abstracts away refreshing tokens. */
	protected twitchAuthProvider!: RefreshingAuthProvider;

	/** The twitch api client. */
	protected twitchApiClient!: ApiClient;

	/** The scopes to request from twitch. */
	protected twitchScopes = [
		"chat:read",
		"chat:edit",
		"channel:read:redemptions",
		"channel:manage:redemptions",
		"moderator:read:followers",
	];

	/**
	 * Create a new server.
	 */
	constructor(options: ServerConfig) {
		this.port = options.port ?? this.port;
		this.hostName = options.hostName ?? this.hostName;

		// May want to use https in the future.
		this.fullyQualifiedHostName = `http://${this.hostName}${
			this.port ? `:${this.port}` : ""
		}`;

		this.twitchConfig = options.twitch;
		this.botConfig = options.bot;
		this.initTwitch();
	}

	/**
	 * Gets a server config from a file relative to the working directory.
	 */
	static async parseConfigFile(
		fileName = "./config/server.yaml"
	): Promise<ServerConfig> {
		const filePath = path.join(WORKING_DIRECTORY, fileName);
		const file = await fs.readFile(filePath, "utf8");
		return yaml.parse(file) as ServerConfig;
	}

	/**
	 * Set up the twitch auth provider and api client.
	 */
	initTwitch() {
		this.twitchAuthProvider = new RefreshingAuthProvider({
			clientId: this.twitchConfig.clientId,
			clientSecret: this.twitchConfig.clientSecret,
			redirectUri: this.fullyQualifiedHostName + "/twitch/auth-callback",
			appImpliedScopes: this.twitchScopes,
		});

		// Automatically cache access tokens when they are refreshed by the auth provider.
		this.twitchAuthProvider.onRefresh(async (userId, accessToken) =>
			this.cacheTwitchAccessToken(userId, accessToken)
		);

		this.twitchApiClient = new ApiClient({
			authProvider: this.twitchAuthProvider,
		});
	}

	/**
	 * Initialize the server.
	 */
	async start() {
		// The directory of this file. (Node's native __dirname is not available in ES modules.)
		const __dirname = getDirName(import.meta);

		// STATIC FILES
		this.express.use(express.static(__dirname + "/public"));

		// HOME PAGE
		this.express.get("/", (_req, res) => {
			res.sendFile(__dirname + "/public/index.html");
		});

		// TWITCH AUTH FLOW
		// https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow
		this.express.get("/twitch/auth", (req, res) =>
			this.routeRedirectTwitchAuth(req, res)
		);

		// TWITCH AUTH CALLBACK
		this.express.get("/twitch/auth-callback", (req, res) =>
			this.routeTwitchAuthCallback(req, res)
		);

		// Start the server
		this.http.listen(this.port, () => {
			console.log(`SERVER LISTENING: ${this.fullyQualifiedHostName}`);
			console.log(
				`TWITCH AUTH URL: ${this.fullyQualifiedHostName}/twitch/auth`
			);
		});

		// Load cached twitch access tokens
		await this.loadCachedTwitchAccessTokens();
	}

	/**
	 * This is used to redirect the user to twitch to authorize the app.
	 * The user will be redirected to /twitch/auth-callback after authorizing.
	 */
	routeRedirectTwitchAuth(req: express.Request, res: express.Response) {
		// Store a temporary secret so we can verify the auth callback is legit later.
		const state = crypto.randomBytes(20).toString("hex");

		// The secret will expire after DEFAULT_TWITCH_AUTH_TIMEOUT
		this.twitchAuthState[state] = setTimeout(() => {
			if (this.twitchAuthState[state]) delete this.twitchAuthState[state];
		}, Server.DEFAULT_TWITCH_AUTH_TIMEOUT);

		// Construct authorization url
		const url = new URL("https://id.twitch.tv/oauth2/authorize");
		url.searchParams.append("client_id", this.twitchConfig.clientId);
		url.searchParams.append(
			"redirect_uri",
			this.fullyQualifiedHostName + "/twitch/auth-callback"
		);
		url.searchParams.append("response_type", "code");
		url.searchParams.append("scope", this.twitchScopes.join(" "));
		url.searchParams.append("state", state);

		// Redirect user to url
		res.header("Location", url.toString());
		res.status(302).send();
	}

	/**
	 * This is used to handle the twitch auth callback.
	 * The user will be redirected here after authorizing the app.
	 * This will exchange the authorization code for an access token.
	 * The access token will be cached for future use.
	 */
	async routeTwitchAuthCallback(req: express.Request, res: express.Response) {
		const authorizationCode = req.query.code;
		const state = req.query.state;

		// Make sure the request is legit.
		if (!authorizationCode || !state || !this.twitchAuthState[state]) {
			res.status(400).send("Invalid request.");
			return;
		}
		delete this.twitchAuthState[state];

		// Exchange the authorization code for an access token,
		// adding the user to the auth provider in the process.
		const twitchUserId = await this.twitchAuthProvider.addUserForCode(
			authorizationCode
		);

		const accessToken = await this.twitchAuthProvider.getAccessTokenForUser(
			twitchUserId
		);

		if (!accessToken) {
			res.status(500).send("Failed to get access token.");
			return;
		}

		const user = await this.twitchApiClient.users.getUserById(twitchUserId);
		if (!user) {
			res.status(500).send("Failed to load user.");
			return;
		}

		// Cache the access token for future use.
		this.cacheTwitchAccessToken(twitchUserId, accessToken);

		console.log({user});

		if (user.name === this.botConfig.user) {
			this.createBot(user);
		}

		res.send(`welcome ${user.name}!`);
	}

	/**
	 * Cache an access token for a user.
	 */
	async cacheTwitchAccessToken(userId: string, accessToken: AccessToken) {
		const filePath = path.join(
			WORKING_DIRECTORY,
			`./_cache/twitch.${userId}.json`
		);

		await fs.writeFile(filePath, JSON.stringify(accessToken));
	}

	/**
	 * Remove a cached access token for a user.
	 */
	async uncacheTwitchAccessToken(userId: string) {
		const filePath = path.join(
			WORKING_DIRECTORY,
			`./_cache/twitch.${userId}.json`
		);

		await fs.rm(filePath);
	}

	/**
	 * Load cached twitch access tokens.
	 */
	async loadCachedTwitchAccessTokens() {
		const cachedTokenFolder = path.join(WORKING_DIRECTORY, "./_cache");
		const fileNames = await fs.readdir(cachedTokenFolder);

		for (const fileName of fileNames) {
			if (!fileName.startsWith("twitch.")) continue;

			const userId = fileName.split(".")[1];

			// Read the accessToken from the file
			const filePath = path.join(cachedTokenFolder, fileName);
			const accessToken = JSON.parse(await fs.readFile(filePath, "utf8"));
			if (!accessToken) {
				// Something went wrong, remove the file.
				this.uncacheTwitchAccessToken(userId);
				continue;
			}

			// Add the user to the auth provider
			this.twitchAuthProvider.addUser(userId, accessToken);

			// Load the user from the api client
			const user = await this.twitchApiClient.users.getUserById(userId);
			if (!user) {
				console.error(`Failed to load twitch user ${userId}`);
				continue;
			}

			console.log(`Loaded twitch user ${user.name} (${userId})`);

			if (user.name === this.botConfig.user) {
				this.createBot(user);
			}
		}
	}

	/**
	 * Create a chat bot user.
	 */
	async createBot(user: HelixUser) {
		console.log("Creating bot...", user.name);

		// Add chat intent to user.
		// Without this, the bot will not be able to read/respond to chat.
		this.twitchAuthProvider.addIntentsToUser(user, ["chat"]);

		const bot = new Bot({
			authProvider: this.twitchAuthProvider,
			channels: [this.botConfig.channel],
			prefix: "~",
			commands: [
				createBotCommand("shoot", async (commandArgs, context) => {
					console.log(`${context.userDisplayName} used: ~shoot`);
				}),
				createBotCommand("left", async (commandArgs, context) => {
					console.log(`${context.userDisplayName} used: ~left`);
				}),
				createBotCommand("right", async (commandArgs, context) => {
					console.log(`${context.userDisplayName} used: ~right`);
				}),
			],
		});

		bot.onMessage(async (message) => {
			console.log(message.userDisplayName + ":", message.text);
		});

		console.log("Bot created.");

		return bot;
	}
}
