import {Server} from "./Server.mts";

const serverConfig = await Server.parseConfigFile("./config/server.yaml");
const server = new Server(serverConfig);
server.start();
