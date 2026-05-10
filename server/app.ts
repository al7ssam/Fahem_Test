import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { config } from "./config";
import { registerAdminRoutes } from "./routes/admin";
import { registerCustomLessonRoutes } from "./routes/customLessons";
import { registerLessonAiPromptRoutes } from "./routes/lessonAiPrompt";
import { registerUserSavedLessonsRoutes } from "./routes/userSavedLessons";
import { registerMeCustomLessonPromptRoutes } from "./routes/meCustomLessonPrompt";
import { registerAuthRoutes } from "./routes/auth";
import { registerProfileRoutes } from "./routes/profile";
import { optionalAuth } from "./auth/middleware";

export function createApp() {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: false,
      // Required for OAuth popup postMessage handshakes (Firebase/Google).
      // `same-origin` can break popup flows by isolating the opener context.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      // Keep disabled unless we intentionally adopt cross-origin isolation.
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: config.clientOrigin ?? true,
      credentials: true,
    }),
  );

  app.use((req, res, next) => {
    const requestId = String(req.header("x-request-id") ?? "").trim() || crypto.randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "fahem" });
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  const jsonrepairUmdPath = path.join(
    process.cwd(),
    "node_modules",
    "jsonrepair",
    "lib",
    "umd",
    "jsonrepair.min.js",
  );
  app.get("/vendor/jsonrepair.min.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(jsonrepairUmdPath);
  });
  const lessonPasteJsonPath = path.join(process.cwd(), "server", "static", "lessonPasteJson.js");
  app.get("/assets/lessonPasteJson.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(lessonPasteJsonPath);
  });
  const adminSessionFetchPath = path.join(process.cwd(), "server", "static", "adminSessionFetch.js");
  app.get("/assets/adminSessionFetch.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(adminSessionFetchPath);
  });
  app.use(optionalAuth);
  registerAuthRoutes(app);
  registerProfileRoutes(app);
  registerCustomLessonRoutes(app);
  registerLessonAiPromptRoutes(app);
  registerUserSavedLessonsRoutes(app);
  registerMeCustomLessonPromptRoutes(app);
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
