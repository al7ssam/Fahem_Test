import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { registerAdminRoutes } from "./routes/admin";
import { registerCustomLessonRoutes } from "./routes/customLessons";

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

  app.use(express.json({ limit: "1mb" }));
  registerCustomLessonRoutes(app);
  registerAdminRoutes(app);

  if (config.isProduction) {
    const staticDir = path.join(process.cwd(), "client", "dist");
    app.use(
      express.static(staticDir, {
        setHeaders: (res, filePath) => {
          const normalized = filePath.replace(/\\/g, "/");
          if (normalized.endsWith("/index.html")) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            return;
          }
          if (normalized.includes("/assets/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            return;
          }
          if (normalized.includes("/videos/")) {
            res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
            return;
          }
          res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
        },
      }),
    );
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return app;
}
