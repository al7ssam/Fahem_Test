import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { registerAdminRoutes } from "./routes/admin";

export function createApp() {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: config.clientOrigin ?? true,
      credentials: true,
    }),
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "fahem" });
  });

  app.use(express.json({ limit: "64kb" }));
  registerAdminRoutes(app);

  if (config.isProduction) {
    const staticDir = path.join(process.cwd(), "client", "dist");
    app.use(express.static(staticDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return app;
}
