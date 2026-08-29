export function isGitHubUrl(url: URL): boolean {
   const hostname = url.hostname.toLowerCase();
   return hostname === "github.com" || hostname === "raw.githubusercontent.com";
}

export function transformGitHubUrl(url: URL): string | undefined {
   const hostname = url.hostname.toLowerCase();

   if (hostname === "raw.githubusercontent.com") {
      return url.toString();
   }

   if (hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      // Example: owner/repo/blob/main/path/to/file.ts
      if (parts.length >= 4 && parts[2] === "blob") {
         const [owner, repo, , ref, ...rest] = parts;
         return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
      }
      // Example: owner/repo/raw/main/path/to/file.ts
      if (parts.length >= 4 && parts[2] === "raw") {
         const [owner, repo, , ref, ...rest] = parts;
         return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
      }
   }

   return undefined;
}
