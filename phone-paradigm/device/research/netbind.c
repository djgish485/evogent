/* netbind.so — LD_PRELOAD shim so the codex brain (glibc, via grun) can reach the network on
 * Termux/Android.
 *
 * Two problems, two hooks:
 *  1. glibc's getaddrinfo() resolves DNS through INTERNAL __socket/__connect aliases that
 *     LD_PRELOAD can't interpose, and those sockets aren't marked for Android's network by
 *     netd, so they get no route (EAI_AGAIN) even though bionic networking works. We interpose
 *     getaddrinfo() itself with a minimal DNS/A-record client that queries 8.8.8.8 over a UDP
 *     socket we BIND to the WiFi source IP (Android routes by source address, no fwmark needed).
 *  2. codex's own connection then uses the PUBLIC socket() symbol (via Rust socket2), which we
 *     interpose to bind the same WiFi source IP so the TCP connect routes out wlan0.
 *
 * IPv4-only (the WiFi source is IPv4); good enough for the OpenAI endpoints.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <netdb.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>

static int (*real_socket)(int, int, int) = 0;

static void nlog(const char *msg) {
    FILE *f = fopen("/data/data/com.termux/files/home/netbind.log", "a");
    if (f) { fputs(msg, f); fputc('\n', f); fclose(f); }
}

static int wlan_ipv4(struct in_addr *out) {
    struct ifaddrs *head, *i; int rc = -1;
    if (getifaddrs(&head) != 0) return -1;
    for (i = head; i; i = i->ifa_next)
        if (i->ifa_addr && i->ifa_addr->sa_family == AF_INET &&
            strncmp(i->ifa_name, "wlan", 4) == 0) {
            *out = ((struct sockaddr_in *)i->ifa_addr)->sin_addr; rc = 0; break;
        }
    freeifaddrs(head);
    return rc;
}

/* ---- hook 2: bind every external AF_INET socket to the WiFi source IP ---- */
int socket(int domain, int type, int protocol) {
    if (!real_socket) real_socket = dlsym(RTLD_NEXT, "socket");
    int fd = real_socket(domain, type, protocol);
    if (fd >= 0 && domain == AF_INET) {
        int st = type & 0xff;
        if (st == SOCK_STREAM || st == SOCK_DGRAM) {
            struct sockaddr_in src; memset(&src, 0, sizeof src); src.sin_family = AF_INET;
            if (wlan_ipv4(&src.sin_addr) == 0) {
                int r = bind(fd, (struct sockaddr *)&src, sizeof src);
                char b[96]; snprintf(b, sizeof b, "socket bind fd=%d rc=%d src=%s", fd, r, inet_ntoa(src.sin_addr));
                nlog(b);
            } else nlog("socket: no wlan ip");
        }
    }
    return fd;
}

/* ---- hook 1: resolve A records ourselves over a source-bound UDP socket ---- */
static int dns_query_a(const char *host, uint32_t *ipv4_net) {
    unsigned char q[512]; int qn = 0;
    uint16_t id = (uint16_t)(getpid() & 0xffff);
    q[qn++] = id >> 8; q[qn++] = id & 0xff;
    q[qn++] = 0x01; q[qn++] = 0x00;      /* recursion desired */
    q[qn++] = 0; q[qn++] = 1;            /* qdcount=1 */
    q[qn++] = 0; q[qn++] = 0; q[qn++] = 0; q[qn++] = 0; q[qn++] = 0; q[qn++] = 0;
    const char *p = host;
    while (*p) {                          /* qname labels */
        const char *dot = strchr(p, '.'); int l = dot ? (int)(dot - p) : (int)strlen(p);
        if (l <= 0 || l > 63) return -1;
        q[qn++] = (unsigned char)l; memcpy(q + qn, p, l); qn += l;
        if (!dot) break; p = dot + 1;
    }
    q[qn++] = 0;                          /* root */
    q[qn++] = 0; q[qn++] = 1;             /* qtype A */
    q[qn++] = 0; q[qn++] = 1;             /* qclass IN */

    int fd = socket(AF_INET, SOCK_DGRAM, 0);   /* our socket() hook binds the WiFi source */
    if (fd < 0) return -1;
    struct timeval tv = { 5, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    struct sockaddr_in ns; memset(&ns, 0, sizeof ns);
    ns.sin_family = AF_INET; ns.sin_port = htons(53); ns.sin_addr.s_addr = inet_addr("8.8.8.8");
    if (sendto(fd, q, qn, 0, (struct sockaddr *)&ns, sizeof ns) < 0) { close(fd); return -1; }
    unsigned char r[1024];
    int n = recv(fd, r, sizeof r, 0);
    close(fd);
    if (n < 12) return -1;
    int ancount = (r[6] << 8) | r[7];
    if (ancount < 1) return -1;
    int off = 12;
    /* skip question */
    while (off < n && r[off]) { if ((r[off] & 0xc0) == 0xc0) { off += 2; goto q_done; } off += r[off] + 1; }
    off += 1;
q_done:
    off += 4;                             /* qtype+qclass */
    for (int a = 0; a < ancount && off + 12 <= n; a++) {
        if ((r[off] & 0xc0) == 0xc0) off += 2; else { while (off < n && r[off]) off += r[off] + 1; off += 1; }
        int type = (r[off] << 8) | r[off + 1];
        int rdlen = (r[off + 8] << 8) | r[off + 9];
        off += 10;
        if (type == 1 && rdlen == 4 && off + 4 <= n) {
            memcpy(ipv4_net, r + off, 4);
            return 0;
        }
        off += rdlen;
    }
    return -1;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    if (!node) return EAI_NONAME;
    { char b[128]; snprintf(b, sizeof b, "getaddrinfo node=%s svc=%s", node, service ? service : "-"); nlog(b); }
    uint32_t ip;
    struct in_addr lit;
    if (inet_aton(node, &lit)) ip = lit.s_addr;       /* already an IP literal */
    else if (dns_query_a(node, &ip) != 0) return EAI_AGAIN;

    int port = 0;
    if (service) for (const char *s = service; *s >= '0' && *s <= '9'; s++) port = port * 10 + (*s - '0');

    struct addrinfo *ai = calloc(1, sizeof *ai);
    struct sockaddr_in *sa = calloc(1, sizeof *sa);
    if (!ai || !sa) { free(ai); free(sa); return EAI_MEMORY; }
    sa->sin_family = AF_INET;
    sa->sin_port = htons((uint16_t)port);
    sa->sin_addr.s_addr = ip;
    ai->ai_family = AF_INET;
    ai->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    ai->ai_protocol = hints ? hints->ai_protocol : 0;
    ai->ai_addrlen = sizeof *sa;
    ai->ai_addr = (struct sockaddr *)sa;
    ai->ai_next = 0;
    *res = ai;
    return 0;
}

void freeaddrinfo(struct addrinfo *ai) {
    while (ai) { struct addrinfo *nx = ai->ai_next; free(ai->ai_addr); free(ai); ai = nx; }
}
