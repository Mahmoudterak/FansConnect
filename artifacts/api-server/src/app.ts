import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { gupshupWebhookHandler } from "./routes/channels";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cookieParser());
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.cookies?.fc_session) return next();

  const configuredOrigin = process.env.PUBLIC_APP_URL?.trim();
  if (!configuredOrigin) {
    return res.status(503).json({
      error: "SERVER_CONFIGURATION_ERROR",
      message: "The server cannot validate this authenticated request.",
    });
  }

  let trustedOrigin: string;
  try {
    trustedOrigin = new URL(configuredOrigin).origin;
  } catch {
    return res.status(503).json({
      error: "SERVER_CONFIGURATION_ERROR",
      message: "The server cannot validate this authenticated request.",
    });
  }

  let requestOrigin: string | null = null;
  try {
    const originHeader = req.get("origin");
    requestOrigin = originHeader ? new URL(originHeader).origin : null;
  } catch {
    requestOrigin = null;
  }

  if (requestOrigin !== trustedOrigin) {
    return res.status(403).json({
      error: "UNTRUSTED_ORIGIN",
      message: "This authenticated request came from an untrusted origin.",
    });
  }
  return next();
});
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.post("/webhook/gupshup", gupshupWebhookHandler);
app.use("/api", router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: error }, "Unhandled API request error");
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "The server could not complete this request." });
});

export default app;
