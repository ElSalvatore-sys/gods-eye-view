import { createJarvisBridgeRoute } from './bridge.js';

/**
 * Mounts the Jarvis bridge at /api/jarvis on the development and preview servers (before the API's not-found route).
 * @param {Parameters<typeof createJarvisBridgeRoute>[0]} [options]
 */
export function jarvisBridgePlugin(options) {
  let route = null;
  const install = ({ middlewares }) => {
    route ??= createJarvisBridgeRoute(options);
    middlewares.use('/api/jarvis', (req, res, next) => {
      Promise.resolve(route(req, res, next)).catch(next);
    });
  };
  return { name: 'gev-jarvis-bridge', configureServer: install, configurePreviewServer: install };
}
