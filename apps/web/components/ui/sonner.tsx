"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "rounded-xl border-border bg-card text-card-foreground shadow-lg shadow-black/10",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
