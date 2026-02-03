/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Some wallet-connect dependencies try to resolve pino-pretty for Node logging.
    // It's not needed in the browser bundle and breaks Next's module resolution.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'pino-pretty': false,
    };
    return config;
  },
};

export default nextConfig;
