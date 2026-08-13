use super::{
    LoginProviderAuthKind, LoginProviderAuthStateKey, LoginProviderDescriptor,
    LoginProviderSurfaceOrder, LoginProviderTarget,
};

#[path = "profiles.rs"]
mod profiles;
pub use profiles::*;

pub const CLAUDE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "claude",
    display_name: "Anthropic/Claude",
    auth_kind: LoginProviderAuthKind::OAuth,
    auth_state_key: LoginProviderAuthStateKey::Anthropic,
    auth_status_method: "OAuth",
    aliases: &["anthropic"],
    menu_detail: "requires Claude Pro or Max subscription",
    recommended: true,
    target: LoginProviderTarget::Claude,
    order: LoginProviderSurfaceOrder::new(Some(1), Some(1), Some(1), Some(1), Some(1)),
};

pub const ANTHROPIC_API_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "anthropic-api",
    display_name: "Anthropic API",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::Anthropic,
    auth_status_method: "API key",
    aliases: &["claude-api", "anthropic-key", "claude-key"],
    menu_detail: "direct Anthropic Messages API",
    recommended: false,
    target: LoginProviderTarget::ClaudeApiKey,
    order: LoginProviderSurfaceOrder::new(Some(2), Some(2), Some(2), Some(2), Some(2)),
};

pub const AUTO_IMPORT_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "auto-import",
    display_name: "Auto Import",
    auth_kind: LoginProviderAuthKind::Local,
    auth_state_key: LoginProviderAuthStateKey::ExternalImport,
    auth_status_method: "Reuse detected logins",
    aliases: &["import", "reuse", "autoimport"],
    menu_detail: "review and reuse logins from other tools",
    recommended: false,
    target: LoginProviderTarget::AutoImport,
    order: LoginProviderSurfaceOrder::new(Some(1), Some(1), None, None, None),
};

pub const ARTERM_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "arterm",
    display_name: "Arterm Subscription",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::Arterm,
    auth_status_method: "API key",
    aliases: &["subscription", "arterm-subscription"],
    menu_detail: "curated arterm subscription models",
    recommended: false,
    target: LoginProviderTarget::Arterm,
    order: LoginProviderSurfaceOrder::new(Some(3), Some(3), Some(3), Some(3), Some(3)),
};

pub const OPENAI_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "openai",
    display_name: "OpenAI",
    auth_kind: LoginProviderAuthKind::OAuth,
    auth_state_key: LoginProviderAuthStateKey::OpenAi,
    auth_status_method: "OAuth",
    aliases: &[],
    menu_detail: "requires ChatGPT Plus or Pro subscription",
    recommended: true,
    target: LoginProviderTarget::OpenAi,
    order: LoginProviderSurfaceOrder::new(Some(2), Some(2), Some(2), Some(2), Some(2)),
};

pub const OPENAI_API_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "openai-api",
    display_name: "OpenAI API",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenAi,
    auth_status_method: "API key",
    aliases: &[
        "openai-key",
        "openai-apikey",
        "openai-platform",
        "platform-openai",
    ],
    menu_detail: "native OpenAI API key, pay-per-token",
    recommended: false,
    target: LoginProviderTarget::OpenAiApiKey,
    order: LoginProviderSurfaceOrder::new(Some(99), Some(99), Some(99), Some(99), Some(99)),
};

pub const OPENROUTER_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "openrouter",
    display_name: "OpenRouter",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key, pay-per-token, 200+ models",
    recommended: false,
    target: LoginProviderTarget::OpenRouter,
    order: LoginProviderSurfaceOrder::new(Some(4), Some(3), Some(4), Some(3), Some(3)),
};

pub const BEDROCK_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "bedrock",
    display_name: "AWS Bedrock",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::Bedrock,
    auth_status_method: "API key / AWS credentials",
    aliases: &["aws-bedrock", "aws_bedrock"],
    menu_detail: "Bedrock API key or AWS credentials, pay-per-token",
    recommended: false,
    target: LoginProviderTarget::Bedrock,
    order: LoginProviderSurfaceOrder::new(Some(5), Some(4), None, None, Some(4)),
};

pub const AZURE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "azure",
    display_name: "Azure OpenAI",
    auth_kind: LoginProviderAuthKind::Hybrid,
    auth_state_key: LoginProviderAuthStateKey::Azure,
    auth_status_method: "Entra ID / API key",
    aliases: &["azure-openai", "azure_openai", "aoai"],
    menu_detail: "Microsoft Entra ID or Azure OpenAI API key",
    recommended: false,
    target: LoginProviderTarget::Azure,
    order: LoginProviderSurfaceOrder::new(Some(5), Some(5), None, None, Some(4)),
};

pub const OPENCODE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "opencode",
    display_name: "OpenCode Zen",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["opencode-zen", "zen"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(OPENCODE_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(5), Some(4), Some(5), Some(4), Some(4)),
};

pub const OPENCODE_GO_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "opencode-go",
    display_name: "OpenCode Go",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["opencodego"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(OPENCODE_GO_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(6), Some(5), Some(6), Some(5), Some(5)),
};

pub const ZAI_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "zai",
    display_name: "Z.AI",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["z.ai", "z-ai", "zai-coding", "zhipu"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(ZAI_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(7), Some(6), Some(7), Some(6), Some(6)),
};

pub const KIMI_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "kimi",
    display_name: "Kimi Code",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[
        "kimi-code",
        "kimi-coding",
        "kimi-coding-plan",
        "kimi-for-coding",
        "moonshot-coding",
    ],
    menu_detail: "API key, dedicated Kimi coding endpoint",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(KIMI_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(36), Some(36), Some(36), Some(36), Some(36)),
};

pub const CHUTES_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "chutes",
    display_name: "Chutes",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(CHUTES_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(8), Some(7), Some(8), Some(7), Some(7)),
};

pub const CEREBRAS_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "cerebras",
    display_name: "Cerebras",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["cerebrascode", "cerberascode"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(CEREBRAS_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(9), Some(8), Some(9), Some(8), Some(8)),
};

pub const ALIBABA_CODING_PLAN_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "alibaba-coding-plan",
    display_name: "Alibaba Cloud Coding Plan",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["bailian", "aliyun-bailian", "coding-plan", "alibaba-coding"],
    menu_detail: "API key, dedicated Alibaba coding endpoint",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(ALIBABA_CODING_PLAN_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(10), Some(9), Some(10), Some(9), Some(9)),
};

pub const AI302_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "302ai",
    display_name: "302.AI",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["302.ai"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(AI302_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(18), Some(18), Some(18), Some(18), Some(18)),
};

pub const BASETEN_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "baseten",
    display_name: "Baseten",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(BASETEN_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(19), Some(19), Some(19), Some(19), Some(19)),
};

pub const CORTECS_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "cortecs",
    display_name: "Cortecs",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(CORTECS_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(20), Some(20), Some(20), Some(20), Some(20)),
};

pub const DEEPSEEK_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "deepseek",
    display_name: "DeepSeek",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(DEEPSEEK_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(21), Some(21), Some(21), Some(21), Some(21)),
};

pub const COMTEGRA_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "comtegra",
    display_name: "Comtegra GPU Cloud",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["cgc", "comtegra-gpu-cloud"],
    menu_detail: "OpenAI-compatible LLM API",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(COMTEGRA_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(22), Some(22), Some(22), Some(22), Some(22)),
};

pub const FPT_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "fpt",
    display_name: "FPT AI Marketplace",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["fpt-ai", "fptcloud", "fpt-cloud"],
    menu_detail: "OpenAI-compatible FPT AI Marketplace API",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(FPT_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(23), Some(23), Some(23), Some(23), Some(23)),
};

pub const FIRMWARE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "firmware",
    display_name: "Firmware",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(FIRMWARE_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(24), Some(24), Some(24), Some(24), Some(24)),
};

pub const HUGGING_FACE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "huggingface",
    display_name: "Hugging Face",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["hugging-face", "hf"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(HUGGING_FACE_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(25), Some(25), Some(25), Some(25), Some(25)),
};

pub const MOONSHOT_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "moonshotai",
    display_name: "Moonshot AI",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["moonshot"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(MOONSHOT_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(26), Some(26), Some(26), Some(26), Some(26)),
};

pub const NEBIUS_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "nebius",
    display_name: "Nebius Token Factory",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(NEBIUS_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(27), Some(27), Some(27), Some(27), Some(27)),
};

pub const SCALEWAY_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "scaleway",
    display_name: "Scaleway",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(SCALEWAY_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(28), Some(28), Some(28), Some(28), Some(28)),
};

pub const STACKIT_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "stackit",
    display_name: "STACKIT",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(STACKIT_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(29), Some(29), Some(29), Some(29), Some(29)),
};

pub const GROQ_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "groq",
    display_name: "Groq",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(GROQ_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(30), Some(30), Some(30), Some(30), Some(30)),
};

pub const MISTRAL_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "mistral",
    display_name: "Mistral",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["mistralai"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(MISTRAL_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(29), Some(29), Some(29), Some(29), Some(29)),
};

pub const PERPLEXITY_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "perplexity",
    display_name: "Perplexity",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["pplx"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(PERPLEXITY_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(30), Some(30), Some(30), Some(30), Some(30)),
};

pub const TOGETHER_AI_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "togetherai",
    display_name: "Together AI",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["together", "together-ai"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(TOGETHER_AI_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(31), Some(31), Some(31), Some(31), Some(31)),
};

pub const DEEPINFRA_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "deepinfra",
    display_name: "Deep Infra",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["deep-infra"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(DEEPINFRA_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(32), Some(32), Some(32), Some(32), Some(32)),
};

pub const FIREWORKS_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "fireworks",
    display_name: "Fireworks",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["fireworks-ai", "fireworks.ai"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(FIREWORKS_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(37), Some(37), Some(37), Some(37), Some(37)),
};

pub const MINIMAX_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "minimax",
    display_name: "MiniMax",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["minimaxi", "minimax-ai"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(MINIMAX_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(38), Some(38), Some(38), Some(38), Some(38)),
};

pub const XAI_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "xai",
    display_name: "xAI",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["x.ai", "x-ai", "grok"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(XAI_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(33), Some(33), Some(33), Some(33), Some(33)),
};

/// A Grok subscription instead of a metered key: same endpoint and models as
/// `XAI_PROFILE`, different credential, listed just before the key entry.
pub const XAI_OAUTH_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "xai-oauth",
    display_name: "xAI (Grok subscription)",
    auth_kind: LoginProviderAuthKind::DeviceCode,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "Grok subscription",
    aliases: &["grok-oauth", "xai-grok", "grok-login"],
    menu_detail: "Sign in with SuperGrok or X Premium+",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(XAI_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(32), Some(32), None, None, Some(32)),
};

pub const NVIDIA_NIM_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "nvidia-nim",
    display_name: "NVIDIA NIM",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["nvidia", "nim"],
    menu_detail: "API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(NVIDIA_NIM_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(34), Some(34), Some(34), Some(34), Some(34)),
};

pub const LMSTUDIO_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "lmstudio",
    display_name: "LM Studio",
    auth_kind: LoginProviderAuthKind::Local,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "local endpoint",
    aliases: &["lm-studio"],
    menu_detail: "local OpenAI-compatible endpoint",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(LMSTUDIO_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(34), Some(34), Some(34), Some(34), Some(34)),
};

pub const OLLAMA_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "ollama",
    display_name: "Ollama",
    auth_kind: LoginProviderAuthKind::Local,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "local endpoint",
    aliases: &[],
    menu_detail: "local OpenAI-compatible endpoint",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(OLLAMA_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(35), Some(35), Some(35), Some(35), Some(35)),
};

pub const OPENAI_COMPAT_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "openai-compatible",
    display_name: "OpenAI-compatible",
    auth_kind: LoginProviderAuthKind::Hybrid,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key / local endpoint",
    aliases: &["openai_compatible", "compat", "custom"],
    menu_detail: "custom endpoint setup: base URL first, then API key",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(OPENAI_COMPAT_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(10), Some(9), None, None, Some(9)),
};

pub const CURSOR_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "cursor",
    display_name: "Cursor",
    auth_kind: LoginProviderAuthKind::Hybrid,
    auth_state_key: LoginProviderAuthStateKey::Cursor,
    auth_status_method: "API key / CLI",
    aliases: &[],
    menu_detail: "browser login or API key",
    recommended: false,
    target: LoginProviderTarget::Cursor,
    order: LoginProviderSurfaceOrder::new(Some(11), Some(12), None, Some(9), Some(12)),
};

pub const COPILOT_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "copilot",
    display_name: "GitHub Copilot",
    auth_kind: LoginProviderAuthKind::DeviceCode,
    auth_state_key: LoginProviderAuthStateKey::Copilot,
    auth_status_method: "device code",
    aliases: &[],
    menu_detail: "GitHub device flow",
    recommended: false,
    target: LoginProviderTarget::Copilot,
    order: LoginProviderSurfaceOrder::new(Some(3), Some(10), Some(3), Some(10), Some(10)),
};

pub const GEMINI_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "gemini",
    display_name: "Google Gemini",
    auth_kind: LoginProviderAuthKind::OAuth,
    auth_state_key: LoginProviderAuthStateKey::Gemini,
    auth_status_method: "OAuth",
    aliases: &[],
    menu_detail: "Google Gemini Code Assist OAuth login",
    recommended: false,
    target: LoginProviderTarget::Gemini,
    order: LoginProviderSurfaceOrder::new(Some(13), Some(11), Some(4), Some(11), Some(13)),
};

pub const GEMINI_API_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "gemini-api",
    display_name: "Gemini API",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &[
        "gemini-key",
        "gemini-apikey",
        "google-ai-studio",
        "ai-studio",
    ],
    menu_detail: "Google AI Studio Developer API key (OpenAI-compatible)",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(GEMINI_OPENAI_COMPAT_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(38), Some(38), Some(38), Some(38), Some(38)),
};

pub const ANTIGRAVITY_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "antigravity",
    display_name: "Antigravity",
    auth_kind: LoginProviderAuthKind::OAuth,
    auth_state_key: LoginProviderAuthStateKey::Antigravity,
    auth_status_method: "OAuth",
    aliases: &[],
    menu_detail: "Google Antigravity OAuth login",
    recommended: false,
    target: LoginProviderTarget::Antigravity,
    order: LoginProviderSurfaceOrder::new(Some(12), Some(12), None, Some(12), Some(12)),
};

pub const XIAOMI_MIMO_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "xiaomi-mimo",
    display_name: "Xiaomi MiMo",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["xiaomi", "mimo", "xiaomi-mimo-api"],
    menu_detail: "OpenAI-compatible Xiaomi MiMo API",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(XIAOMI_MIMO_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(37), Some(37), Some(37), Some(37), Some(37)),
};

pub const META_MUSE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "meta-muse",
    display_name: "Meta Model API",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["meta", "muse", "muse-spark", "meta-model-api", "meta-ai"],
    menu_detail: "OpenAI-compatible Meta Model API",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(META_MUSE_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(38), Some(38), Some(38), Some(38), Some(38)),
};

pub const CELERIS_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "celeris",
    display_name: "Celeris",
    auth_kind: LoginProviderAuthKind::ApiKey,
    auth_state_key: LoginProviderAuthStateKey::OpenRouterLike,
    auth_status_method: "API key",
    aliases: &["celeris-ai", "celeris1", "celeris-1"],
    menu_detail: "OpenAI-compatible low-latency Celeris API",
    recommended: false,
    target: LoginProviderTarget::OpenAiCompatible(CELERIS_PROFILE),
    order: LoginProviderSurfaceOrder::new(Some(38), Some(38), Some(38), Some(38), Some(38)),
};

pub const GOOGLE_LOGIN_PROVIDER: LoginProviderDescriptor = LoginProviderDescriptor {
    id: "google",
    display_name: "Google/Gmail",
    auth_kind: LoginProviderAuthKind::OAuth,
    auth_state_key: LoginProviderAuthStateKey::Google,
    auth_status_method: "OAuth",
    aliases: &["gmail"],
    menu_detail: "read, draft, and send emails",
    recommended: false,
    target: LoginProviderTarget::Google,
    order: LoginProviderSurfaceOrder::new(Some(13), None, None, None, None),
};

pub(crate) const LOGIN_PROVIDERS: [LoginProviderDescriptor; 50] = [
    AUTO_IMPORT_LOGIN_PROVIDER,
    CLAUDE_LOGIN_PROVIDER,
    ANTHROPIC_API_LOGIN_PROVIDER,
    OPENAI_LOGIN_PROVIDER,
    OPENAI_API_LOGIN_PROVIDER,
    ARTERM_LOGIN_PROVIDER,
    OPENROUTER_LOGIN_PROVIDER,
    BEDROCK_LOGIN_PROVIDER,
    AZURE_LOGIN_PROVIDER,
    OPENCODE_LOGIN_PROVIDER,
    OPENCODE_GO_LOGIN_PROVIDER,
    ZAI_LOGIN_PROVIDER,
    KIMI_LOGIN_PROVIDER,
    CHUTES_LOGIN_PROVIDER,
    CEREBRAS_LOGIN_PROVIDER,
    ALIBABA_CODING_PLAN_LOGIN_PROVIDER,
    AI302_LOGIN_PROVIDER,
    BASETEN_LOGIN_PROVIDER,
    CORTECS_LOGIN_PROVIDER,
    DEEPSEEK_LOGIN_PROVIDER,
    COMTEGRA_LOGIN_PROVIDER,
    FPT_LOGIN_PROVIDER,
    FIRMWARE_LOGIN_PROVIDER,
    HUGGING_FACE_LOGIN_PROVIDER,
    MOONSHOT_LOGIN_PROVIDER,
    NEBIUS_LOGIN_PROVIDER,
    SCALEWAY_LOGIN_PROVIDER,
    STACKIT_LOGIN_PROVIDER,
    GROQ_LOGIN_PROVIDER,
    MISTRAL_LOGIN_PROVIDER,
    PERPLEXITY_LOGIN_PROVIDER,
    TOGETHER_AI_LOGIN_PROVIDER,
    DEEPINFRA_LOGIN_PROVIDER,
    FIREWORKS_LOGIN_PROVIDER,
    MINIMAX_LOGIN_PROVIDER,
    XAI_OAUTH_LOGIN_PROVIDER,
    XAI_LOGIN_PROVIDER,
    NVIDIA_NIM_LOGIN_PROVIDER,
    XIAOMI_MIMO_LOGIN_PROVIDER,
    META_MUSE_LOGIN_PROVIDER,
    CELERIS_LOGIN_PROVIDER,
    LMSTUDIO_LOGIN_PROVIDER,
    OLLAMA_LOGIN_PROVIDER,
    OPENAI_COMPAT_LOGIN_PROVIDER,
    CURSOR_LOGIN_PROVIDER,
    COPILOT_LOGIN_PROVIDER,
    GEMINI_LOGIN_PROVIDER,
    GEMINI_API_LOGIN_PROVIDER,
    ANTIGRAVITY_LOGIN_PROVIDER,
    GOOGLE_LOGIN_PROVIDER,
];
