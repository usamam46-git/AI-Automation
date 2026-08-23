import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    // The signed-out surface's photographic panel (app/(auth)/layout.tsx) is the
    // only remote image in the app. Narrowed to the exact host and to Unsplash's
    // immutable `/photo-*` path so this allowance cannot quietly widen into
    // "any URL a future component feels like rendering".
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com", pathname: "/photo-**" }],
  },
};

export default nextConfig;
