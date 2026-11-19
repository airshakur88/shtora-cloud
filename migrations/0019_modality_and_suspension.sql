-- Fase 2 (R8/R10) + Fase 4 (R25, B2) da auditoria do 502 (2026-11-19).
-- Só dados: nenhuma rota ou regra de roteamento muda aqui; o consumo
-- destas colunas (filtro de modalidade, flag de suspeita, suspensão)
-- chega nas fases seguintes.
--
-- models.modality: 'chat' por padrão; linhas de imagem/áudio/vídeo
-- passam a carregar a modalidade real, para que /v1/models e o roteador
-- chat possam excluí-las (R8). models.suspect_reason/suspect_since:
-- flag de linha suspeita para o job de validação de catálogo (R10).
-- api_keys.suspended_until_ms/suspension_reason: suspensão temporária
-- com reabilitação automática para o probe de chaves (R7, Fase 2.4).
--
-- Os UPDATEs de modalidade listam só modelos comprovadamente não-chat
-- (geração de imagem, TTS/STT): a lista foi derivada das migrations
-- 0011-0014 (linhas presentes num banco fresco) e 0006 (linhas que só
-- existem num banco antigo/divergido). UPDATE por (platform, model_id)
-- não falha quando a linha não existe, então os da 0006 são no-ops num
-- banco fresco e corrigem o banco de produção divergido.
-- Modelos de visão/linguagem (llava, llama vision, qwen omni, voxtral,
-- guard models) SÃO chat e ficam com modality='chat'.

ALTER TABLE models ADD COLUMN modality TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE models ADD COLUMN suspect_reason TEXT;
ALTER TABLE models ADD COLUMN suspect_since INTEGER;
ALTER TABLE api_keys ADD COLUMN suspended_until_ms INTEGER;
ALTER TABLE api_keys ADD COLUMN suspension_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_models_modality ON models(modality);

-- Imagem: geração de imagem (0011-0014).
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/black-forest-labs/flux-1-schnell';
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
-- Áudio: TTS (0011-0014).
UPDATE models SET modality = 'audio' WHERE platform = 'cloudflare' AND model_id = '@cf/myshell-ai/melotts';
UPDATE models SET modality = 'audio' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash-preview-tts';
UPDATE models SET modality = 'audio' WHERE platform = 'electronhub' AND model_id = 'gemini-3.8-flash-tts';
UPDATE models SET modality = 'audio' WHERE platform = 'electronhub' AND model_id = 'gemini-3.8-flash-lite-tts';
UPDATE models SET modality = 'audio' WHERE platform = 'electronhub' AND model_id = 'humain-tts';
UPDATE models SET modality = 'audio' WHERE platform = 'freeai' AND model_id = 'kokoro';

-- Imagem/áudio referenciados só na 0006 (no-ops num banco fresco).
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/black-forest-labs/flux-2-klein-9b';
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/black-forest-labs/flux-2-klein-4b';
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/black-forest-labs/flux-2-dev';
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/bytedance/stable-diffusion-xl-lightning';
UPDATE models SET modality = 'audio' WHERE platform = 'cloudflare' AND model_id = '@cf/deepgram/aura-1';
UPDATE models SET modality = 'audio' WHERE platform = 'cloudflare' AND model_id = '@cf/deepgram/aura-2-en';
UPDATE models SET modality = 'audio' WHERE platform = 'cloudflare' AND model_id = '@cf/deepgram/aura-2-es';
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/leonardo/lucid-origin';
UPDATE models SET modality = 'image' WHERE platform = 'cloudflare' AND model_id = '@cf/leonardo/phoenix-1.0';
UPDATE models SET modality = 'audio' WHERE platform = 'google' AND model_id = 'gemini-3.1-flash-tts-preview';
UPDATE models SET modality = 'image' WHERE platform = 'agnes' AND model_id = 'agnes-image-2.0-flash';
UPDATE models SET modality = 'image' WHERE platform = 'agnes' AND model_id = 'agnes-image-2.1-flash';
UPDATE models SET modality = 'audio' WHERE platform = 'speechify' AND model_id = 'simba-3.2';
UPDATE models SET modality = 'audio' WHERE platform = 'speechify' AND model_id = 'simba-3.0';

-- B2: Devstral Small 2 (2512) suporta function calling nativo (formato
-- Mistral de tool calls; validado em harnesses de agentes) — o catálogo
-- marcava supports_tools=0. As duas linhas são o mesmo modelo sob ids
-- diferentes (electronhub); a linha xkiro (devstral-medium, Devstral 2)
-- já estava com 1. A premissa da auditoria de que devstral-2512 seria
-- membro de shtora/coding está desatualizada: nenhum router virtual
-- referencia devstral hoje, então nada muda em virtual-routers.ts.
UPDATE models SET supports_tools = 1 WHERE platform = 'electronhub' AND model_id = 'devstral-2512';
UPDATE models SET supports_tools = 1 WHERE platform = 'electronhub' AND model_id = 'labs-devstral-small-2512';
