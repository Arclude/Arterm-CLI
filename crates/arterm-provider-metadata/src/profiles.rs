//! The OpenAI-compatible endpoint profiles: who they are, where they live,
//! which env var carries their key. Split from `catalog.rs`, which keeps the
//! login-provider descriptors; both are registries and they grow independently.

use crate::OpenAiCompatibleProfile;

pub const OPENCODE_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "opencode",
    display_name: "OpenCode Zen",
    api_base: "https://opencode.ai/zen/v1",
    api_key_env: "OPENCODE_API_KEY",
    env_file: "opencode.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("minimax-m2.7"),
    requires_api_key: true,
};

pub const OPENCODE_GO_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "opencode-go",
    display_name: "OpenCode Go",
    api_base: "https://opencode.ai/zen/go/v1",
    api_key_env: "OPENCODE_GO_API_KEY",
    env_file: "opencode-go.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("kimi-k2.5"),
    requires_api_key: true,
};

pub const ZAI_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "zai",
    display_name: "Z.AI",
    api_base: "https://api.z.ai/api/coding/paas/v4",
    api_key_env: "ZHIPU_API_KEY",
    env_file: "zai.env",
    setup_url: "https://docs.z.ai/guides/develop/openai/introduction",
    default_model: Some("glm-4.5"),
    requires_api_key: true,
};

pub const KIMI_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "kimi",
    display_name: "Kimi Code",
    api_base: "https://api.kimi.com/coding/v1",
    api_key_env: "KIMI_API_KEY",
    env_file: "kimi.env",
    setup_url: "https://www.kimi.com/coding/docs/en/more/third-party-agents.html",
    default_model: Some("kimi-for-coding"),
    requires_api_key: true,
};

pub const AI302_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "302ai",
    display_name: "302.AI",
    api_base: "https://api.302.ai/v1",
    api_key_env: "302AI_API_KEY",
    env_file: "302ai.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("qwen3-235b-a22b-instruct-2507"),
    requires_api_key: true,
};

pub const BASETEN_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "baseten",
    display_name: "Baseten",
    api_base: "https://inference.baseten.co/v1",
    api_key_env: "BASETEN_API_KEY",
    env_file: "baseten.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("zai-org/GLM-4.7"),
    requires_api_key: true,
};

pub const CORTECS_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "cortecs",
    display_name: "Cortecs",
    api_base: "https://api.cortecs.ai/v1",
    api_key_env: "CORTECS_API_KEY",
    env_file: "cortecs.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("kimi-k2.5"),
    requires_api_key: true,
};

// OpenRouter also has a dedicated provider implementation elsewhere, but it
// speaks the standard OpenAI-compatible /api/v1 endpoint, so it can be driven
// by `provider-doctor` / `provider-test-coverage` like any other
// OpenAI-compatible provider. `default_model` is None so the doctor selects the
// live catalog's first model unless `--model` is passed.
pub const OPENROUTER_OPENAI_COMPAT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "openrouter",
    display_name: "OpenRouter",
    api_base: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    env_file: "openrouter.env",
    setup_url: "https://openrouter.ai/keys",
    default_model: None,
    requires_api_key: true,
};

// Anthropic and OpenAI also expose OpenAI-compatible `/v1/chat/completions`
// endpoints, so they can be driven by `provider-doctor` /
// `provider-test-coverage` as OpenAI-compatible profiles. These profile ids
// alias the native login-provider ids (`anthropic-api`, `openai-api`); auth
// activation deliberately routes them through the native runtime, while the
// live HTTP probes hit these hosts (Anthropic needs `x-api-key` +
// `anthropic-version`, handled in the probe layer). `default_model` is None so
// the doctor selects from the live catalog unless `--model` is passed.
pub const ANTHROPIC_OPENAI_COMPAT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "anthropic-api",
    display_name: "Anthropic API",
    api_base: "https://api.anthropic.com/v1",
    api_key_env: "ANTHROPIC_API_KEY",
    env_file: "anthropic.env",
    setup_url: "https://docs.anthropic.com/en/api/openai-sdk",
    default_model: None,
    requires_api_key: true,
};

pub const OPENAI_NATIVE_OPENAI_COMPAT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "openai-api",
    display_name: "OpenAI API",
    api_base: "https://api.openai.com/v1",
    api_key_env: "OPENAI_API_KEY",
    env_file: "openai.env",
    setup_url: "https://platform.openai.com/api-keys",
    default_model: None,
    requires_api_key: true,
};

pub const GEMINI_OPENAI_COMPAT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "gemini-api",
    display_name: "Gemini API",
    // Google's official OpenAI-compatible surface for the Gemini Developer API.
    // The `/models` endpoint here returns `models/`-prefixed ids, which the live
    // probe layer normalizes back to bare model names.
    api_base: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key_env: "GEMINI_API_KEY",
    env_file: "gemini.env",
    setup_url: "https://ai.google.dev/gemini-api/docs/openai",
    default_model: Some("gemini-2.5-flash"),
    requires_api_key: true,
};

pub const DEEPSEEK_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "deepseek",
    display_name: "DeepSeek",
    api_base: "https://api.deepseek.com",
    api_key_env: "DEEPSEEK_API_KEY",
    env_file: "deepseek.env",
    setup_url: "https://api-docs.deepseek.com/",
    default_model: Some("deepseek-v4-flash"),
    requires_api_key: true,
};

pub const COMTEGRA_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "comtegra",
    display_name: "Comtegra GPU Cloud",
    api_base: "https://llm.comtegra.cloud/v1",
    api_key_env: "COMTEGRA_API_KEY",
    env_file: "comtegra.env",
    setup_url: "https://docs.cgc.comtegra.cloud/llm-api",
    default_model: Some("glm-51-nvfp4"),
    requires_api_key: true,
};

pub const FPT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "fpt",
    display_name: "FPT AI Marketplace",
    api_base: "https://mkp-api.fptcloud.com",
    api_key_env: "FPT_API_KEY",
    env_file: "fpt.env",
    setup_url: "https://ai-docs.fptcloud.com/api-reference/ai-marketplace/api-reference/api-integration-large-language-model-md",
    default_model: Some("GLM-5.1"),
    requires_api_key: true,
};

pub const FIRMWARE_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "firmware",
    display_name: "Firmware",
    api_base: "https://app.frogbot.ai/api/v1",
    api_key_env: "FIRMWARE_API_KEY",
    env_file: "firmware.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("kimi-k2.5"),
    requires_api_key: true,
};

pub const HUGGING_FACE_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "huggingface",
    display_name: "Hugging Face",
    api_base: "https://router.huggingface.co/v1",
    api_key_env: "HF_TOKEN",
    env_file: "huggingface.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("zai-org/GLM-4.7"),
    requires_api_key: true,
};

pub const MOONSHOT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "moonshotai",
    display_name: "Moonshot AI",
    api_base: "https://api.moonshot.ai/v1",
    api_key_env: "MOONSHOT_API_KEY",
    env_file: "moonshotai.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("kimi-k2.5"),
    requires_api_key: true,
};

pub const NEBIUS_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "nebius",
    display_name: "Nebius Token Factory",
    api_base: "https://api.tokenfactory.nebius.com/v1",
    api_key_env: "NEBIUS_API_KEY",
    env_file: "nebius.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("openai/gpt-oss-120b"),
    requires_api_key: true,
};

pub const SCALEWAY_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "scaleway",
    display_name: "Scaleway",
    api_base: "https://api.scaleway.ai/v1",
    api_key_env: "SCALEWAY_API_KEY",
    env_file: "scaleway.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("qwen3-coder-30b-a3b-instruct"),
    requires_api_key: true,
};

pub const STACKIT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "stackit",
    display_name: "STACKIT",
    api_base: "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1",
    api_key_env: "STACKIT_API_KEY",
    env_file: "stackit.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: Some("openai/gpt-oss-120b"),
    requires_api_key: true,
};

pub const GROQ_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "groq",
    display_name: "Groq",
    api_base: "https://api.groq.com/openai/v1",
    api_key_env: "GROQ_API_KEY",
    env_file: "groq.env",
    setup_url: "https://console.groq.com/docs/openai",
    default_model: Some("llama-3.1-8b-instant"),
    requires_api_key: true,
};

pub const MISTRAL_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "mistral",
    display_name: "Mistral",
    api_base: "https://api.mistral.ai/v1",
    api_key_env: "MISTRAL_API_KEY",
    env_file: "mistral.env",
    setup_url: "https://docs.mistral.ai/getting-started/models/",
    default_model: Some("devstral-medium-2507"),
    requires_api_key: true,
};

pub const PERPLEXITY_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "perplexity",
    display_name: "Perplexity",
    api_base: "https://api.perplexity.ai",
    api_key_env: "PERPLEXITY_API_KEY",
    env_file: "perplexity.env",
    setup_url: "https://docs.perplexity.ai/docs/agent-api/openai-compatibility",
    default_model: Some("sonar"),
    requires_api_key: true,
};

pub const TOGETHER_AI_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "togetherai",
    display_name: "Together AI",
    api_base: "https://api.together.xyz/v1",
    api_key_env: "TOGETHER_API_KEY",
    env_file: "togetherai.env",
    setup_url: "https://docs.together.ai/docs/openai-api-compatibility",
    default_model: Some("moonshotai/Kimi-K2-Instruct"),
    requires_api_key: true,
};

pub const DEEPINFRA_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "deepinfra",
    display_name: "Deep Infra",
    api_base: "https://api.deepinfra.com/v1/openai",
    api_key_env: "DEEPINFRA_API_KEY",
    env_file: "deepinfra.env",
    setup_url: "https://deepinfra.com/docs/api-reference",
    default_model: Some("moonshotai/Kimi-K2-Instruct"),
    requires_api_key: true,
};

pub const FIREWORKS_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "fireworks",
    display_name: "Fireworks",
    api_base: "https://api.fireworks.ai/inference/v1",
    api_key_env: "FIREWORKS_API_KEY",
    env_file: "fireworks.env",
    setup_url: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
    default_model: Some("accounts/fireworks/routers/kimi-k2p5-turbo"),
    requires_api_key: true,
};

pub const MINIMAX_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "minimax",
    display_name: "MiniMax",
    api_base: "https://api.minimax.io/v1",
    api_key_env: "OPENAI_API_KEY",
    env_file: "minimax.env",
    setup_url: "https://platform.minimax.io/docs/guides/text-generation",
    default_model: Some("MiniMax-M2.7"),
    requires_api_key: true,
};

pub const XAI_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "xai",
    display_name: "xAI",
    api_base: "https://api.x.ai/v1",
    api_key_env: "XAI_API_KEY",
    env_file: "xai.env",
    setup_url: "https://docs.x.ai/developers/quickstart",
    // `grok-code-fast-1` was the default until 2026-08-14, when a live
    // `/v1/models` against a Grok subscription came back without it: the
    // default named a model the account could not use, so the one row the
    // picker showed was also the one row that would fail.
    default_model: Some("grok-4.6"),
    requires_api_key: true,
};

pub const LMSTUDIO_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "lmstudio",
    display_name: "LM Studio",
    api_base: "http://localhost:1234/v1",
    api_key_env: "LMSTUDIO_API_KEY",
    env_file: "lmstudio.env",
    setup_url: "https://lmstudio.ai/docs/app/api/endpoints/openai",
    default_model: None,
    requires_api_key: false,
};

pub const OLLAMA_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "ollama",
    display_name: "Ollama",
    api_base: "http://localhost:11434/v1",
    api_key_env: "OLLAMA_API_KEY",
    env_file: "ollama.env",
    setup_url: "https://docs.ollama.com/api/openai-compatibility",
    default_model: None,
    requires_api_key: false,
};

pub const CHUTES_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "chutes",
    display_name: "Chutes",
    api_base: "https://llm.chutes.ai/v1",
    api_key_env: "CHUTES_API_KEY",
    env_file: "chutes.env",
    setup_url: "https://chutes.ai",
    // Chutes' accessible models change with capacity/key access. Do not keep a
    // static default here: post-login activation should select from the live
    // `/models` catalog instead of advertising a stale model that may 404 at
    // chat/completions time.
    default_model: None,
    requires_api_key: true,
};

pub const CEREBRAS_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "cerebras",
    display_name: "Cerebras",
    api_base: "https://api.cerebras.ai/v1",
    api_key_env: "CEREBRAS_API_KEY",
    env_file: "cerebras.env",
    setup_url: "https://inference-docs.cerebras.ai/introduction",
    default_model: Some("gpt-oss-120b"),
    requires_api_key: true,
};

pub const ALIBABA_CODING_PLAN_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "alibaba-coding-plan",
    display_name: "Alibaba Cloud Coding Plan",
    api_base: "https://coding-intl.dashscope.aliyuncs.com/v1",
    api_key_env: "BAILIAN_CODING_PLAN_API_KEY",
    env_file: "alibaba-coding-plan.env",
    setup_url: "https://www.alibabacloud.com/help/en/model-studio/coding-plan-quickstart",
    default_model: Some("qwen3-coder-plus"),
    requires_api_key: true,
};

pub const NVIDIA_NIM_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "nvidia-nim",
    display_name: "NVIDIA NIM",
    api_base: "https://integrate.api.nvidia.com/v1",
    api_key_env: "NVIDIA_API_KEY",
    env_file: "nvidia-nim.env",
    setup_url: "https://build.nvidia.com/explore/discover",
    default_model: Some("nvidia/llama-3.1-nemotron-ultra-253b-v1"),
    requires_api_key: true,
};

pub const XIAOMI_MIMO_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "xiaomi-mimo",
    display_name: "Xiaomi MiMo",
    api_base: "https://api.xiaomimimo.com/v1",
    api_key_env: "XIAOMI_MIMO_API_KEY",
    env_file: "xiaomi-mimo.env",
    setup_url: "https://platform.xiaomimimo.com",
    default_model: Some("mimo-v2.5"),
    requires_api_key: true,
};

pub const META_MUSE_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "meta-muse",
    display_name: "Meta Model API",
    api_base: "https://api.meta.ai/v1",
    api_key_env: "META_MUSE_API_KEY",
    env_file: "meta-muse.env",
    setup_url: "https://dev.meta.ai/",
    default_model: Some("muse-spark-1.2"),
    requires_api_key: true,
};

pub const CELERIS_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "celeris",
    display_name: "Celeris",
    // Celeris scopes the base URL per model: https://inference.celeris.ai/<model>/v1.
    // `celeris-1` is the only served model today.
    api_base: "https://inference.celeris.ai/celeris-1/v1",
    api_key_env: "CELERIS_API_KEY",
    env_file: "celeris.env",
    setup_url: "https://docs.celeris.ai/",
    default_model: Some("celeris-1"),
    requires_api_key: true,
};

pub const OPENAI_COMPAT_PROFILE: OpenAiCompatibleProfile = OpenAiCompatibleProfile {
    id: "openai-compatible",
    display_name: "OpenAI-compatible",
    api_base: "https://api.openai.com/v1",
    api_key_env: "OPENAI_COMPAT_API_KEY",
    env_file: "openai-compatible.env",
    setup_url: "https://github.com/Arclude/Arterm-CLI#openai-compatible-providers",
    default_model: None,
    requires_api_key: true,
};

pub(crate) const OPENAI_COMPAT_PROFILES: [OpenAiCompatibleProfile; 38] = [
    OPENCODE_PROFILE,
    OPENCODE_GO_PROFILE,
    ZAI_PROFILE,
    KIMI_PROFILE,
    CHUTES_PROFILE,
    CEREBRAS_PROFILE,
    ALIBABA_CODING_PLAN_PROFILE,
    AI302_PROFILE,
    BASETEN_PROFILE,
    CORTECS_PROFILE,
    OPENROUTER_OPENAI_COMPAT_PROFILE,
    ANTHROPIC_OPENAI_COMPAT_PROFILE,
    OPENAI_NATIVE_OPENAI_COMPAT_PROFILE,
    GEMINI_OPENAI_COMPAT_PROFILE,
    DEEPSEEK_PROFILE,
    COMTEGRA_PROFILE,
    FPT_PROFILE,
    FIRMWARE_PROFILE,
    HUGGING_FACE_PROFILE,
    MOONSHOT_PROFILE,
    NEBIUS_PROFILE,
    SCALEWAY_PROFILE,
    STACKIT_PROFILE,
    GROQ_PROFILE,
    MISTRAL_PROFILE,
    PERPLEXITY_PROFILE,
    TOGETHER_AI_PROFILE,
    DEEPINFRA_PROFILE,
    FIREWORKS_PROFILE,
    MINIMAX_PROFILE,
    XAI_PROFILE,
    NVIDIA_NIM_PROFILE,
    XIAOMI_MIMO_PROFILE,
    META_MUSE_PROFILE,
    CELERIS_PROFILE,
    LMSTUDIO_PROFILE,
    OLLAMA_PROFILE,
    OPENAI_COMPAT_PROFILE,
];
