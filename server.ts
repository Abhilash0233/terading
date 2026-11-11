import express from "express";
import { createApp } from "./server/app.js";

const app: express.Express = createApp();

export default app;
