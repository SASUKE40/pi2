import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// Credentials use Pi's environment-based resolver; this module stores no keys.
// Refuse a route mismatch rather than silently changing the billing endpoint.
export default function () {
  const models = builtinModels();
  const provider = process.env.PI2_GLM_PROVIDER ?? 'zai-coding-cn';
  const model = models.getModel(provider, 'glm-5.3-flash');
  if (!model || process.env.PI2_GLM_BASE_URL && model.baseUrl !== process.env.PI2_GLM_BASE_URL)
    throw new Error('GLM endpoint does not match the built-in provider');
  return models;
}
