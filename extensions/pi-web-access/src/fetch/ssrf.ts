import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
   constructor(message: string) {
      super(message);
      this.name = "SsrfError";
   }
}

export function isPrivateIpv4(ip: string): boolean {
   const parts = ip.split(".").map((segment) => Number.parseInt(segment, 10));
   if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true;
   }

   const [a = 0, b = 0, c = 0, d = 0] = parts;

   // 0.0.0.0/8
   if (a === 0) return true;
   // 10.0.0.0/8
   if (a === 10) return true;
   // 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
   if (a === 100 && b >= 64 && b <= 127) return true;
   // 127.0.0.0/8
   if (a === 127) return true;
   // 169.254.0.0/16
   if (a === 169 && b === 254) return true;
   // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
   if (a === 172 && b >= 16 && b <= 31) return true;
   // 192.0.0.0/24, 192.0.2.0/24
   if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
   // 192.168.0.0/16
   if (a === 192 && b === 168) return true;
   // 198.18.0.0/15 (198.18.0.0 - 198.19.255.255)
   if (a === 198 && (b === 18 || b === 19)) return true;
   // 198.51.100.0/24
   if (a === 198 && b === 51 && c === 100) return true;
   // 203.0.113.0/24
   if (a === 203 && b === 0 && c === 113) return true;
   // 224.0.0.0/4 (multicast)
   if (a >= 224 && a <= 239) return true;
   // 240.0.0.0/4 (reserved)
   if (a >= 240) return true;
   // 255.255.255.255
   if (a === 255 && b === 255 && c === 255 && d === 255) return true;

   return false;
}

export function isPrivateIpv6(ip: string): boolean {
   const normalized = ip.toLowerCase().trim();

   // Unspecified & loopback
   if (normalized === "::" || normalized === "::1") return true;

   // IPv4 mapped IPv6 (::ffff:192.0.2.128 or ::ffff:c000:0280)
   if (normalized.startsWith("::ffff:")) {
      const ipv4Part = normalized.slice(7);
      if (isIP(ipv4Part) === 4) {
         return isPrivateIpv4(ipv4Part);
      }
   }

   // Unique local address fc00::/7 (fc00:: - fdff::)
   if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

   // Link-local fe80::/10 (fe80:: - febf::)
   if (/^fe[89ab]/i.test(normalized)) return true;

   // Multicast ff00::/8
   if (normalized.startsWith("ff")) return true;

   return false;
}

export function isPrivateIp(ip: string): boolean {
   const version = isIP(ip);
   if (version === 4) return isPrivateIpv4(ip);
   if (version === 6) return isPrivateIpv6(ip);
   return true;
}

export function isForbiddenHostname(hostname: string): boolean {
   const lower = hostname.toLowerCase().trim();

   if (
      lower === "localhost" ||
      lower.endsWith(".localhost") ||
      lower.endsWith(".local") ||
      lower.endsWith(".internal") ||
      lower.endsWith(".lan") ||
      lower.endsWith(".home.arpa") ||
      lower.endsWith(".intranet")
   ) {
      return true;
   }

   if (isIP(lower)) {
      return isPrivateIp(lower);
   }

   return false;
}

export async function validateSafeUrl(urlString: string): Promise<URL> {
   let url: URL;
   try {
      url = new URL(urlString);
   } catch {
      throw new SsrfError(`Invalid URL format: "${urlString}"`);
   }

   if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfError(`Unsupported protocol "${url.protocol}". Only HTTP and HTTPS are permitted.`);
   }

   const hostname = url.hostname;
   if (!hostname) {
      throw new SsrfError(`Invalid URL missing hostname: "${urlString}"`);
   }

   if (isForbiddenHostname(hostname)) {
      throw new SsrfError(`Access to host "${hostname}" is blocked for security.`);
   }

   // If the hostname is an IP, we already checked it above.
   if (isIP(hostname)) {
      return url;
   }

   // DNS lookup to verify resolved addresses
   try {
      const addresses = await lookup(hostname, { all: true });
      if (!addresses || addresses.length === 0) {
         throw new SsrfError(`Could not resolve hostname "${hostname}".`);
      }

      for (const entry of addresses) {
         if (isPrivateIp(entry.address)) {
            throw new SsrfError(`Host "${hostname}" resolved to blocked IP "${entry.address}".`);
         }
      }
   } catch (error) {
      if (error instanceof SsrfError) {
         throw error;
      }
      throw new SsrfError(
         `DNS resolution failed for host "${hostname}": ${error instanceof Error ? error.message : String(error)}`
      );
   }

   return url;
}
