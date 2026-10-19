import { describe, expect, it, onTestFinished } from "vitest";

import {
  addAiAccountRequestSchema,
  aiAccountKindOf,
  aiProviderOfModel,
  aiProviderTakes,
  kindServes,
  modelFamilyOf,
  platformEndpointUrl,
  platformModel,
  type AiAccountKind,
} from "./ai-accounts.ts";
import { allowInternalHosts } from "./internal-hosts.ts";
import { mappedModel, modelSentTo } from "./model-mappings.ts";

// AWS Bedrock and Google Vertex AI AI Accounts (PRD FR-35): Claude through
// a cloud platform, in a region, with the platform's own names for Models
// and its own credentials.

const kind = (accountType: string): AiAccountKind => {
  const found = aiAccountKindOf({ aiProvider: "Claude", accountType });
  if (found === undefined) {
    throw new Error(`No Claude ${accountType} kind.`);
  }
  return found;
};
const bedrock = kind("bedrock");
const vertex = kind("vertex");

describe("a cloud platform's names for Claude Models", () => {
  it("are Bedrock's: an anthropic. prefix, no snapshot date", () => {
    expect(platformModel(bedrock, "claude-opus-5-5")).toBe(
      "anthropic.claude-opus-5-5",
    );
    expect(platformModel(bedrock, "claude-haiku-4-5-20251001")).toBe(
      "anthropic.claude-haiku-4-5",
    );
    // Bedrock's own names, and inference profiles, stay as they are.
    for (const model of [
      "anthropic.claude-opus-5-5",
      "us.anthropic.claude-opus-5-5",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/x",
    ]) {
      expect(platformModel(bedrock, model)).toBe(model);
    }
  });

  it("are Vertex AI's: a snapshot date after @", () => {
    expect(platformModel(vertex, "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(platformModel(vertex, "claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5@20251001",
    );
    expect(platformModel(vertex, "claude-haiku-4-5@20251001")).toBe(
      "claude-haiku-4-5@20251001",
    );
  });

  it("leave every other kind's Models alone", () => {
    expect(platformModel(kind("api_key"), "claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("are what a mapping, an alias or a forced Model is sent as", () => {
    const bedrockKind = { aiProvider: "Claude", accountType: "bedrock" };
    const mappings = [
      {
        from: "opus",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
      },
      {
        from: "claude-sonnet-5-5",
        to: "us.anthropic.claude-sonnet-5-5",
        aiProvider: "Claude",
        accountType: "bedrock",
      },
    ];
    expect(mappedModel("opus", bedrockKind, mappings)).toBe(
      "anthropic.claude-opus-5-5",
    );
    expect(mappedModel("claude-sonnet-5-5", bedrockKind, mappings)).toBe(
      "us.anthropic.claude-sonnet-5-5",
    );
    expect(
      modelSentTo(
        { requested: "opus" },
        { ...bedrockKind, forcedModel: "claude-haiku-5-5" },
        mappings,
      ),
    ).toBe("anthropic.claude-haiku-5-5");
    expect(
      modelSentTo(
        { requested: "claude-haiku-4-5-20251001" },
        { aiProvider: "Claude", accountType: "vertex", forcedModel: null },
        [],
      ),
    ).toBe("claude-haiku-4-5@20251001");
  });

  it("are still Claude's, of the same family", () => {
    for (const model of [
      "anthropic.claude-opus-5-5",
      "global.anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "claude-haiku-4-5@20251001",
    ]) {
      expect(aiProviderOfModel(model)).toBe("Claude");
    }
    expect(modelFamilyOf("us.anthropic.claude-opus-4-6-v1")).toBe(
      "claude-opus",
    );
    expect(modelFamilyOf("claude-haiku-4-5@20251001")).toBe("claude-haiku");
    // A Model that only looks versioned is left whole.
    expect(modelFamilyOf("deepseek-v3")).toBe("deepseek-v3");
  });
});

describe("a cloud platform's endpoint", () => {
  it("is Claude in Amazon Bedrock's, in the region", () => {
    expect(platformEndpointUrl("bedrock", "eu-west-1")).toBe(
      "https://bedrock-mantle.eu-west-1.api.aws",
    );
  });

  it("is Vertex AI's global, multi-region or regional one", () => {
    expect(platformEndpointUrl("vertex", "global")).toBe(
      "https://aiplatform.googleapis.com",
    );
    expect(platformEndpointUrl("vertex", "eu")).toBe(
      "https://aiplatform.eu.rep.googleapis.com",
    );
    expect(platformEndpointUrl("vertex", "us-east5")).toBe(
      "https://us-east5-aiplatform.googleapis.com",
    );
  });

  it("serves Bedrock no token counting, and Vertex AI everything", () => {
    expect(kindServes(bedrock, "count_tokens")).toBe(false);
    expect(kindServes(bedrock, "messages")).toBe(true);
    expect(kindServes(bedrock, "responses")).toBe(true);
    expect(kindServes(vertex, "count_tokens")).toBe(true);
  });
});

describe("adding a cloud platform's account", () => {
  const serviceAccount = {
    type: "service_account",
    project_id: "from-the-key",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    client_email: "office@from-the-key.iam.gserviceaccount.com",
    client_id: "1",
  };
  const vertexAccount = {
    name: "Vertex",
    aiProvider: "Claude",
    accountType: "vertex",
    region: "global",
    serviceAccount: JSON.stringify(serviceAccount),
  };
  const problems = (body: object) => {
    const parsed = addAiAccountRequestSchema.safeParse(body);
    return parsed.success
      ? []
      : parsed.error.issues.map(({ message }) => message);
  };

  it("takes an AWS access key, with or without a session token, or a profile", () => {
    const account = {
      name: "Bedrock",
      aiProvider: "Claude",
      accountType: "bedrock",
      region: "us-gov-west-1",
    };
    for (const awsCredentials of [
      { accessKeyId: "AKIA0000000000000000", secretAccessKey: "s/e+c=" },
      {
        accessKeyId: "ASIA0000000000000000",
        secretAccessKey: "s",
        sessionToken: "t",
      },
      { profile: "ai-office" },
    ]) {
      expect(problems({ ...account, awsCredentials })).toEqual([]);
    }
    expect(problems({ ...account, awsCredentials: {} })).toEqual([
      "Give an access key ID and secret access key, or a profile.",
    ]);
    expect(
      problems({
        ...account,
        region: "us-east",
        awsCredentials: { profile: "ai-office" },
      }),
    ).toEqual(["Enter the AWS region, such as us-east-1."]);
  });

  it("reads the service account's key file, keeping only what it uses", () => {
    const parsed = addAiAccountRequestSchema.parse(vertexAccount);
    expect(parsed).toMatchObject({
      accountType: "vertex",
      serviceAccount: {
        type: "service_account",
        project_id: "from-the-key",
        client_email: serviceAccount.client_email,
      },
    });
    expect(
      parsed.accountType === "vertex" && "client_id" in parsed.serviceAccount,
    ).toBe(false);
  });

  it("needs a project, from the key or the Owner", () => {
    const noProject: Partial<typeof serviceAccount> = { ...serviceAccount };
    delete noProject.project_id;
    const withoutProject = {
      ...vertexAccount,
      serviceAccount: JSON.stringify(noProject),
    };
    expect(problems(withoutProject)).toEqual([
      "The service account key names no project: enter the Google Cloud project ID.",
    ]);
    expect(
      problems({ ...withoutProject, projectId: "billing-project" }),
    ).toEqual([]);
    expect(problems({ ...vertexAccount, projectId: "No" })).toEqual([
      "A Google Cloud project ID is 6 to 30 lowercase letters, digits and hyphens.",
    ]);
  });

  it("names what is wrong with a key file, never quoting it", () => {
    const wrong = problems({
      ...vertexAccount,
      serviceAccount: JSON.stringify({
        ...serviceAccount,
        private_key: "AAAA",
      }),
    });
    expect(wrong).toEqual([
      "The service account key's private_key is not a PEM key.",
    ]);
    expect(problems({ ...vertexAccount, region: "Europe" })).toEqual([
      "Enter the Vertex AI region, such as global or us-east5.",
    ]);
  });
});

// OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys (PRD FR-35): each
// its own AI Provider, its own API in OpenAI's formats, and its own Models.

describe("OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys", () => {
  const apiKey = (aiProvider: string): AiAccountKind => {
    const found = aiAccountKindOf({ aiProvider, accountType: "api_key" });
    if (found === undefined) {
      throw new Error(`No ${aiProvider} API key.`);
    }
    return found;
  };

  it("are each an AI Provider's own API, in OpenAI's formats", () => {
    expect(
      ["OpenRouter", "DeepSeek", "Z.ai", "Minimax", "Kimi"].map(
        (aiProvider) => {
          const kind = apiKey(aiProvider);
          return [
            aiProvider,
            kind.label,
            `${kind.defaultEndpointUrl ?? ""}${kind.apiPath}`,
            kind.apiFormat,
            kind.servesOnly,
          ];
        },
      ),
    ).toEqual([
      [
        "OpenRouter",
        "OpenRouter API key",
        "https://openrouter.ai/api/v1",
        "openai",
        null,
      ],
      [
        "DeepSeek",
        "DeepSeek API key",
        "https://api.deepseek.com",
        "openai",
        null,
      ],
      ["Z.ai", "Z.ai API key", "https://api.z.ai/api/paas/v4", "openai", null],
      [
        "Minimax",
        "MiniMax API key",
        "https://api.minimax.io/v1",
        "openai",
        null,
      ],
      [
        "Kimi",
        "Kimi API key (Moonshot AI)",
        "https://api.moonshot.ai/v1",
        "openai",
        null,
      ],
    ]);
  });

  it("serve Chat Completions and Messages, Responses where their API has it, and count no tokens", () => {
    for (const aiProvider of ["OpenRouter", "DeepSeek", "Minimax", "Kimi"]) {
      const kind = apiKey(aiProvider);
      expect(kindServes(kind, "chat_completions"), aiProvider).toBe(true);
      expect(kindServes(kind, "messages"), aiProvider).toBe(true);
      expect(kindServes(kind, "responses"), aiProvider).toBe(true);
      expect(kindServes(kind, "count_tokens"), aiProvider).toBe(false);
    }
    const zai = apiKey("Z.ai");
    expect(kindServes(zai, "chat_completions")).toBe(true);
    expect(kindServes(zai, "messages")).toBe(true);
    expect(kindServes(zai, "responses")).toBe(false);
    expect(kindServes(zai, "count_tokens")).toBe(false);
  });

  it("route each AI Provider's Models to it by name", () => {
    expect(
      Object.fromEntries(
        [
          "deepseek-flash",
          "deepseek-v4-pro",
          "glm-5.3",
          "glm-4.6",
          "MiniMax-M3",
          "MiniMax-M2.7-highspeed",
          "kimi-k3",
          "kimi-k2.7-code",
          "moonshot-v1-8k",
        ].map((model) => [model, aiProviderOfModel(model)]),
      ),
    ).toEqual({
      "deepseek-flash": "DeepSeek",
      "deepseek-v4-pro": "DeepSeek",
      "glm-5.3": "Z.ai",
      "glm-4.6": "Z.ai",
      "MiniMax-M3": "Minimax",
      "MiniMax-M2.7-highspeed": "Minimax",
      "kimi-k3": "Kimi",
      "kimi-k2.7-code": "Kimi",
      "moonshot-v1-8k": "Kimi",
    });
  });

  it("route OpenRouter's vendor/model names to OpenRouter, whatever the vendor", () => {
    for (const model of [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.5",
      "deepseek/deepseek-v4-pro",
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "openrouter/auto",
    ]) {
      expect(aiProviderOfModel(model), model).toBe("OpenRouter");
    }
    // The vendor's own names stay the vendor's.
    expect(aiProviderOfModel("claude-sonnet-5-5")).toBe("Claude");
    expect(aiProviderOfModel("gpt-5.5")).toBe("ChatGPT");
    // Bedrock's ARNs are not OpenRouter's.
    expect(
      aiProviderOfModel(
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
      ),
    ).not.toBe("OpenRouter");
    // Its family is still the vendor Model's.
    expect(modelFamilyOf("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet");
  });

  it("are added with a key, like any other", () => {
    for (const aiProvider of [
      "OpenRouter",
      "DeepSeek",
      "Z.ai",
      "Minimax",
      "Kimi",
    ]) {
      expect(
        addAiAccountRequestSchema.parse({
          name: aiProvider,
          aiProvider,
          accountType: "api_key",
          credential: " sk-test-0123456789 ",
        }),
      ).toEqual({
        name: aiProvider,
        aiProvider,
        accountType: "api_key",
        credential: "sk-test-0123456789",
      });
    }
    const refused = addAiAccountRequestSchema.safeParse({
      name: "ChatGPT",
      aiProvider: "ChatGPT",
      accountType: "api_key",
      credential: "sk-test-0123456789",
    });
    expect(refused.error?.issues.map(({ message }) => message)).toEqual([
      "Only Claude, Grok, Gemini, OpenRouter, DeepSeek, Z.ai, Minimax, Kimi, Qwen and Ollama API keys can be added so far.",
    ]);
  });
});

// Qwen, Ollama and Ollama Cloud, and any Anthropic- or OpenAI-compatible
// endpoint (PRD FR-35): Qwen through Qwen Code's sign-in, Ollama on the
// Owner's own server or at ollama.com, and an endpoint the Owner names,
// sent whatever Models are asked of it.

describe("Qwen, Ollama and compatible endpoints", () => {
  const kindOf = (aiProvider: string, accountType: string): AiAccountKind => {
    const found = aiAccountKindOf({ aiProvider, accountType });
    if (found === undefined) {
      throw new Error(`No ${aiProvider} ${accountType} kind.`);
    }
    return found;
  };
  const qwen = kindOf("Qwen", "oauth");
  const ollama = kindOf("Ollama", "endpoint");
  const ollamaCloud = kindOf("Ollama", "api_key");
  const anthropicCompatible = kindOf("Anthropic-compatible", "endpoint");
  const openAiCompatible = kindOf("OpenAI-compatible", "endpoint");

  it("are each reached at their own API, or the one the Owner gives", () => {
    expect(
      [qwen, ollama, ollamaCloud, anthropicCompatible, openAiCompatible].map(
        (kind) => [
          kind.label,
          kind.defaultEndpointUrl,
          kind.apiPath,
          kind.apiFormat,
          kind.servesOnly,
          kind.signIn,
        ],
      ),
    ).toEqual([
      [
        "Qwen sign-in (Qwen Code's free tier)",
        "https://portal.qwen.ai",
        "/v1",
        "openai",
        "opencode",
        "device",
      ],
      [
        "Ollama (your own server)",
        "http://localhost:11434",
        "/v1",
        "openai",
        null,
        null,
      ],
      [
        "Ollama Cloud API key",
        "https://ollama.com",
        "/v1",
        "openai",
        null,
        null,
      ],
      // The Owner's URL, with /v1/messages after it.
      ["Anthropic-compatible endpoint", null, "/v1", "anthropic", null, null],
      // The Owner's URL is the API's root, /v1 included.
      ["OpenAI-compatible endpoint", null, "", "openai", null, null],
    ]);
  });

  it("serve what their APIs have, and none counts tokens", () => {
    const served = (kind: AiAccountKind) =>
      (
        [
          "messages",
          "count_tokens",
          "chat_completions",
          "responses",
          "responses_compact",
        ] as const
      ).filter((endpoint) => kindServes(kind, endpoint));
    // A Qwen sign-in serves opencode's Chat Completions only.
    expect(served(qwen)).toEqual(["chat_completions"]);
    expect(served(ollama)).toEqual(["messages", "chat_completions"]);
    expect(served(ollamaCloud)).toEqual(["messages", "chat_completions"]);
    expect(served(anthropicCompatible)).toEqual([
      "messages",
      "chat_completions",
      "responses",
      "responses_compact",
    ]);
    expect(served(openAiCompatible)).toEqual([
      "messages",
      "chat_completions",
      "responses",
    ]);
  });

  it("route Qwen's Models to Qwen, and Ollama's model:tag names to Ollama, whoever made the Model", () => {
    expect(
      Object.fromEntries(
        [
          "qwen3-coder-plus",
          "qwen3-coder-flash",
          "qwen-max",
          "qwq-32b",
          "coder-model",
          "vision-model",
          "llama3.3:70b",
          "gpt-oss:120b",
          "qwen3-coder:30b",
          "deepseek-v3.1:671b-cloud",
          "glm-4.6:cloud",
          "mistral:latest",
        ].map((model) => [model, aiProviderOfModel(model)]),
      ),
    ).toEqual({
      "qwen3-coder-plus": "Qwen",
      "qwen3-coder-flash": "Qwen",
      "qwen-max": "Qwen",
      "qwq-32b": "Qwen",
      "coder-model": "Qwen",
      "vision-model": "Qwen",
      "llama3.3:70b": "Ollama",
      "gpt-oss:120b": "Ollama",
      "qwen3-coder:30b": "Ollama",
      "deepseek-v3.1:671b-cloud": "Ollama",
      "glm-4.6:cloud": "Ollama",
      "mistral:latest": "Ollama",
    });
    // Bedrock's versions and OpenAI's fine-tunes are not Ollama's tags.
    expect(aiProviderOfModel("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe(
      "Claude",
    );
    expect(aiProviderOfModel("us.anthropic.claude-opus-5-5-v1:0")).toBe(
      "Claude",
    );
    expect(aiProviderOfModel("ft:gpt-4o-mini:acme::abc123")).toBeUndefined();
    // A name without a tag is still its maker's.
    expect(aiProviderOfModel("gpt-oss-120b")).toBe("ChatGPT");
  });

  it("send a compatible endpoint any Model, and every other AI Provider only its own and those no one claims", () => {
    for (const aiProvider of ["Anthropic-compatible", "OpenAI-compatible"]) {
      for (const model of [
        "claude-sonnet-5-5",
        "gpt-5.5",
        "meta-llama/Llama-3.3-70B-Instruct",
        "llama3.3:70b",
        "my-own-model",
      ]) {
        expect(aiProviderTakes(aiProvider, model), model).toBe(true);
      }
    }
    expect(aiProviderTakes("Ollama", "llama3.3:70b")).toBe(true);
    expect(aiProviderTakes("Ollama", "claude-sonnet-5-5")).toBe(false);
    expect(aiProviderTakes("Claude", "llama3.3:70b")).toBe(false);
    expect(aiProviderTakes("Qwen", "qwen3-coder-plus")).toBe(true);
    expect(aiProviderTakes("Kimi", "qwen3-coder-plus")).toBe(false);
    // One no AI Provider claims, any may be sent.
    expect(aiProviderTakes("Claude", "my-own-model")).toBe(true);
  });

  it("add an Ollama Cloud key like any other", () => {
    expect(
      addAiAccountRequestSchema.parse({
        name: "Ollama Cloud",
        aiProvider: "Ollama",
        accountType: "api_key",
        credential: "0123456789abcdef.AbCdEf",
      }),
    ).toEqual({
      name: "Ollama Cloud",
      aiProvider: "Ollama",
      accountType: "api_key",
      credential: "0123456789abcdef.AbCdEf",
    });
  });

  it("add an endpoint with its URL, and a key only if it asks for one", () => {
    // The Owner's own servers, on their own machine and network, which
    // they allow (ADR 0007).
    allowInternalHosts(["localhost", ".lan"]);
    onTestFinished(() => {
      allowInternalHosts([]);
    });
    // The Owner's own Ollama: its default address, and no key.
    expect(
      addAiAccountRequestSchema.parse({
        name: "Ollama",
        aiProvider: "Ollama",
        accountType: "endpoint",
      }),
    ).toEqual({
      name: "Ollama",
      aiProvider: "Ollama",
      accountType: "endpoint",
    });
    expect(
      addAiAccountRequestSchema.parse({
        name: "vLLM",
        aiProvider: "OpenAI-compatible",
        accountType: "endpoint",
        endpointUrl: "http://gpu-box.lan:8000/v1",
        credential: null,
      }),
    ).toEqual({
      name: "vLLM",
      aiProvider: "OpenAI-compatible",
      accountType: "endpoint",
      endpointUrl: "http://gpu-box.lan:8000/v1",
      credential: null,
    });
    expect(
      addAiAccountRequestSchema.parse({
        name: "LiteLLM",
        aiProvider: "Anthropic-compatible",
        accountType: "endpoint",
        endpointUrl: "https://llm.example.com",
        credential: " sk-litellm-0123 ",
      }),
    ).toMatchObject({ credential: "sk-litellm-0123" });
    const problems = (body: Record<string, unknown>) =>
      addAiAccountRequestSchema
        .safeParse({ name: "Endpoint", accountType: "endpoint", ...body })
        .error?.issues.map(({ message }) => message);
    // A compatible endpoint has no address of its own.
    expect(problems({ aiProvider: "OpenAI-compatible" })).toEqual([
      "Enter the endpoint's URL.",
    ]);
    expect(
      problems({
        aiProvider: "Anthropic-compatible",
        endpointUrl: "https://user:secret@llm.example.com",
      }),
    ).toEqual([
      "Leave credentials out of the endpoint URL; the key goes in its own field.",
    ]);
    expect(
      problems({
        aiProvider: "OpenAI-compatible",
        endpointUrl: "http://gpu-box.lan:8000/v1",
        credential: "two words",
      }),
    ).toEqual(["An API key has no spaces in it."]);
    expect(problems({ aiProvider: "Claude" })).toEqual([
      "Only an Ollama server, or an Anthropic- or OpenAI-compatible endpoint, can be added as an endpoint.",
    ]);
  });
});
