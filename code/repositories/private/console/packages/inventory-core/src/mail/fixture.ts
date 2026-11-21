export type MailAddress = {
  address: string;
  name?: string;
};

export type MailMessage = {
  id: string;
  subject: string;
  from: MailAddress;
  date: string;
  snippet?: string;
};

export type MailConnectConfig = {
  kind: "fixture" | "imap" | "graph" | "gmail";
  mailbox: string;
};

export type MailListResult = {
  messages: MailMessage[];
};

export type MailProvider = {
  name: string;
  connect: (config: MailConnectConfig) => Promise<void>;
  listMessages: () => Promise<MailListResult>;
};

export function defaultFixtureInbox(): MailMessage[] {
  return [
    {
      id: "msg-1",
      subject: "verify code 4821",
      from: { address: "noreply@example.com" },
      date: "2026-08-18T12:00:00.000Z",
    },
  ];
}

export function createFixtureMailProvider(messages: MailMessage[]): MailProvider {
  let connected = false;
  const stored = [...messages];

  return {
    name: "fixture",
    async connect(_config) {
      connected = true;
    },
    async listMessages() {
      if (!connected) {
        throw new Error("mail provider is not connected");
      }
      return { messages: stored };
    },
  };
}
