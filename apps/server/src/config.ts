export type ServerConfig = {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
};

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.NCHAT_SERVER_PORT ?? 8787),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://nchat:nchat@localhost:5432/nchat",
    jwtSecret:
      process.env.NCHAT_JWT_SECRET ??
      "dev-only-change-this-secret-before-running-any-shared-environment",
    accessTokenTtlSeconds: Number(process.env.NCHAT_ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlDays: Number(process.env.NCHAT_REFRESH_TOKEN_TTL_DAYS ?? 30),
  };
}
