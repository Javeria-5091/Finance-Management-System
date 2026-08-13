// src/lib/ai-registry.ts
// Spec 9.9: ai_model_registry + ai_prompt_versions wiring.
// Centralizes "which model is enabled for this purpose" and "which prompt
// version is active" so both change via a DB row (with its own audit trail
// / approved_by) instead of an unreviewed code edit.

import { createGroq } from '@ai-sdk/groq';

interface ActiveModel {
  provider: string;
  modelId: string;
  maxTokens: number;
  temperature: number;
}

const FALLBACK_MODEL: ActiveModel = {
  provider: 'groq',
  modelId: 'llama-3.3-70b-versatile',
  maxTokens: 4096,
  temperature: 0.1,
};

// Spec 9.9 "enabled" flag — if the row is disabled or missing, fail closed
// to the known-good fallback rather than silently picking any model. This
// is also the single place to route to a different provider (google/xai)
// once ai_model_registry has a row pointing at one.
export async function getActiveModel(supabase: any, purpose: string): Promise<ActiveModel> {
  const { data, error } = await supabase
    .schema('ai')
    .from('ai_model_registry')
    .select('provider, model_id, max_tokens, temperature, enabled')
    .eq('purpose', purpose)
    .eq('enabled', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error(`getActiveModel(${purpose}) error:`, error.message);
    return FALLBACK_MODEL;
  }

  return {
    provider: data.provider,
    modelId: data.model_id,
    maxTokens: data.max_tokens ?? 4096,
    temperature: data.temperature ?? 0.1,
  };
}

// Only groq is wired right now (matches package.json). Extend this switch
// when @ai-sdk/google / @ai-sdk/xai routing is actually needed.
export function resolveModel(active: ActiveModel) {
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  if (active.provider === 'groq') return groq(active.modelId);
  // Unknown/unwired provider in the registry — fail closed to fallback.
  return groq(FALLBACK_MODEL.modelId);
}

// Spec 9.9 ai_prompt_versions: "prompt key, version, checksum, approved_by."
// Fetches the currently active version; falls back to the hardcoded default
// if no active row exists (first deploy, or migration not yet run).
export async function getActivePrompt(supabase: any, promptKey: string, fallback: string): Promise<string> {
  const { data, error } = await supabase
    .schema('ai')
    .from('ai_prompt_versions')
    .select('content')
    .eq('prompt_key', promptKey)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data?.content) {
    if (error) console.error(`getActivePrompt(${promptKey}) error:`, error.message);
    return fallback;
  }
  return data.content;
}

