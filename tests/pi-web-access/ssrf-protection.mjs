import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const ssrf = await loadExtension("extensions/pi-web-access/src/fetch/ssrf.ts");

test("isPrivateIpv4 correctly identifies private and reserved IP addresses", () => {
   // Loopback
   assert.equal(ssrf.isPrivateIpv4("127.0.0.1"), true);
   assert.equal(ssrf.isPrivateIpv4("127.255.255.255"), true);

   // Private RFC 1918
   assert.equal(ssrf.isPrivateIpv4("10.0.0.1"), true);
   assert.equal(ssrf.isPrivateIpv4("10.255.255.255"), true);
   assert.equal(ssrf.isPrivateIpv4("172.16.0.1"), true);
   assert.equal(ssrf.isPrivateIpv4("172.31.255.255"), true);
   assert.equal(ssrf.isPrivateIpv4("192.168.1.1"), true);
   assert.equal(ssrf.isPrivateIpv4("192.168.254.254"), true);

   // Link-local and cloud metadata
   assert.equal(ssrf.isPrivateIpv4("169.254.169.254"), true);
   assert.equal(ssrf.isPrivateIpv4("169.254.1.1"), true);

   // CGNAT
   assert.equal(ssrf.isPrivateIpv4("100.64.0.1"), true);
   assert.equal(ssrf.isPrivateIpv4("100.127.255.255"), true);

   // Zero and broadcast
   assert.equal(ssrf.isPrivateIpv4("0.0.0.0"), true);
   assert.equal(ssrf.isPrivateIpv4("255.255.255.255"), true);

   // Public IPs
   assert.equal(ssrf.isPrivateIpv4("8.8.8.8"), false);
   assert.equal(ssrf.isPrivateIpv4("1.1.1.1"), false);
   assert.equal(ssrf.isPrivateIpv4("140.82.121.4"), false);
   assert.equal(ssrf.isPrivateIpv4("93.184.216.34"), false);
});

test("isPrivateIpv6 correctly identifies private and loopback IPv6 addresses", () => {
   assert.equal(ssrf.isPrivateIpv6("::1"), true);
   assert.equal(ssrf.isPrivateIpv6("::"), true);
   assert.equal(ssrf.isPrivateIpv6("fc00::1"), true);
   assert.equal(ssrf.isPrivateIpv6("fe80::1"), true);
   assert.equal(ssrf.isPrivateIpv6("ff02::1"), true);
   assert.equal(ssrf.isPrivateIpv6("::ffff:127.0.0.1"), true);
   assert.equal(ssrf.isPrivateIpv6("::ffff:10.0.0.1"), true);
   assert.equal(ssrf.isPrivateIpv6("::ffff:8.8.8.8"), false);
   assert.equal(ssrf.isPrivateIpv6("2606:4700:4700::1111"), false);
});

test("isForbiddenHostname identifies internal and localhost hostnames", () => {
   assert.equal(ssrf.isForbiddenHostname("localhost"), true);
   assert.equal(ssrf.isForbiddenHostname("sub.localhost"), true);
   assert.equal(ssrf.isForbiddenHostname("server.local"), true);
   assert.equal(ssrf.isForbiddenHostname("api.internal"), true);
   assert.equal(ssrf.isForbiddenHostname("127.0.0.1"), true);
   assert.equal(ssrf.isForbiddenHostname("169.254.169.254"), true);
   assert.equal(ssrf.isForbiddenHostname("example.com"), false);
   assert.equal(ssrf.isForbiddenHostname("github.com"), false);
});

test("validateSafeUrl rejects non-http protocols and blocked IPs", async () => {
   await assert.rejects(
      async () => ssrf.validateSafeUrl("ftp://example.com/file"),
      /Unsupported protocol/
   );
   await assert.rejects(
      async () => ssrf.validateSafeUrl("file:///etc/passwd"),
      /Unsupported protocol/
   );
   await assert.rejects(
      async () => ssrf.validateSafeUrl("http://127.0.0.1:8080"),
      /blocked for security/
   );
   await assert.rejects(
      async () => ssrf.validateSafeUrl("http://169.254.169.254/latest/meta-data"),
      /blocked for security/
   );
   await assert.rejects(
      async () => ssrf.validateSafeUrl("http://localhost/admin"),
      /blocked for security/
   );
});
