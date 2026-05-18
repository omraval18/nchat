import {
  authResponseSchema,
  connectionSchema,
  groupSchema,
  type AuthResponse,
  type Connection,
  type Group,
  type LoginRequest,
  type SignupRequest,
} from "@nchat/protocol";

export class ApiClient {
  constructor(private readonly serverUrl: string) {}

  async signup(request: SignupRequest): Promise<AuthResponse> {
    return authResponseSchema.parse(await this.post("/auth/signup", request));
  }

  async login(request: LoginRequest): Promise<AuthResponse> {
    return authResponseSchema.parse(await this.post("/auth/login", request));
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    return (await this.post("/auth/refresh", { refreshToken })) as { accessToken: string };
  }

  async connect(username: string, accessToken: string): Promise<void> {
    await this.post("/connections", { username }, accessToken);
  }

  async listConnections(accessToken: string): Promise<Connection[]> {
    const result = (await this.get("/connections", accessToken)) as { connections: unknown[] };
    return result.connections.map((connection) => connectionSchema.parse(connection));
  }

  async createGroup(name: string, accessToken: string): Promise<Group> {
    return groupSchema.parse(await this.post("/groups", { name }, accessToken));
  }

  async listGroups(accessToken: string): Promise<Group[]> {
    const result = (await this.get("/groups", accessToken)) as { groups: unknown[] };
    return result.groups.map((group) => groupSchema.parse(group));
  }

  async addGroupMember(groupId: string, username: string, accessToken: string): Promise<void> {
    await this.post(`/groups/${groupId}/members`, { username }, accessToken);
  }

  private async get(path: string, accessToken?: string): Promise<unknown> {
    return this.request("GET", path, undefined, accessToken);
  }

  private async post(path: string, body: unknown, accessToken?: string): Promise<unknown> {
    return this.request("POST", path, body, accessToken);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<unknown> {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown);
    if (!response.ok) {
      const error = new Error(`request failed ${response.status}: ${text}`);
      error.name = "ApiError";
      throw error;
    }
    return parsed;
  }
}
