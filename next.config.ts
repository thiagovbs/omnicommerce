import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone', // CRUCIAL para Docker
};

export default nextConfig;
