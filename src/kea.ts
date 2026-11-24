/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Parsing for ISC Kea's files. No cockpit imports, so it can be tested
 * on its own.
 *
 * Leases: Kea's "memfile" backend keeps leases in CSV files that it only
 * ever appends to: every new lease, renewal, release or expiry adds a row,
 * and the newest row for an address wins. A row with valid_lifetime 0 means
 * the lease was deleted. Every lfc-interval, Lease File Cleanup (kea-lfc)
 * moves the file to <name>.1, compacts <name>.2 + <name>.1 into a new
 * <name>.2, and removes <name>.1. So the current state is <name>.2, then
 * <name>.1, then <name>, read in that order, like Kea itself does on startup.
 *
 * Config: Kea's JSON allows comments (#, //, and C-style) that JSON.parse
 * does not.
 */

export type Family = 4 | 6;

/* Lease types in the CSV's lease_type column (DHCPv6 only) */
export const LEASE_TYPE_NA = 0;
export const LEASE_TYPE_TA = 1;
export const LEASE_TYPE_PD = 2;

/* The state column */
export const STATE_DEFAULT = 0;
export const STATE_DECLINED = 1;
export const STATE_EXPIRED_RECLAIMED = 2;
export const STATE_RELEASED = 3; // Kea 2.7+ with lease retention; harmless to know

/* Kea's "infinite" valid lifetime */
const INFINITE_LIFETIME = 0xffffffff;

export interface Lease {
    family: Family;
    /* address, or prefix without length for a delegated prefix */
    address: string;
    prefixLen: number | null; // only for IA_PD
    leaseType: number; // LEASE_TYPE_*; always NA for DHCPv4
    hwaddr: string | null;
    clientId: string | null; // DHCPv4 client identifier
    duid: string | null; // DHCPv6
    hostname: string | null;
    subnetId: number | null;
    validLifetime: number; // seconds
    /* times in milliseconds since the epoch; expire null for an infinite lease */
    start: number;
    expire: number | null;
    state: number;
    userContext: Record<string, unknown> | null;
}

/* Kea escapes commas (and a few others) in text columns as "&#xHH" */
function unescapeField(value: string): string {
    return value.replace(/&#x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function nonEmpty(value: string | undefined): string | null {
    return value === undefined || value === "" ? null : value;
}

function parseIntOr<T>(value: string | undefined, fallback: T): number | T {
    if (value === undefined || value === "")
        return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/* DHCPv6 hostnames are stored as FQDNs: "nas." and "." for none */
function normalizeHostname(value: string | null): string | null {
    if (value === null)
        return null;
    const name = value.endsWith(".") ? value.slice(0, -1) : value;
    return name === "" ? null : name;
}

function parseUserContext(value: string | null): Record<string, unknown> | null {
    if (value === null)
        return null;
    try {
        const ctx = JSON.parse(value);
        return ctx && typeof ctx === "object" && !Array.isArray(ctx) ? ctx : null;
    } catch {
        return null;
    }
}

export function leaseKey(lease: Lease): string {
    // An address can be both an IA_NA lease and the start of a delegated
    // prefix; IA_PD prefixes of different lengths can share an address
    return lease.family === 4
        ? lease.address
        : `${lease.leaseType}/${lease.address}/${lease.prefixLen ?? 128}`;
}

/*
 * Parse one lease file into rows, in file order. Columns are found by the
 * header, so the different columns of Kea versions don't matter, as long as
 * the ones used here keep their names. Rows that can't be parsed (e.g. a
 * half-written last line) are skipped.
 */
export function parseLeaseFile(family: Family, content: string): Lease[] {
    const lines = content.split("\n");
    const header = lines[0]?.trim().split(",") ?? [];
    const col = (name: string) => header.indexOf(name);
    const c = {
        address: col("address"),
        hwaddr: col("hwaddr"),
        clientId: col("client_id"),
        duid: col("duid"),
        valid: col("valid_lifetime"),
        expire: col("expire"),
        subnet: col("subnet_id"),
        leaseType: col("lease_type"),
        prefixLen: col("prefix_len"),
        hostname: col("hostname"),
        state: col("state"),
        userContext: col("user_context"),
    };
    if (c.address < 0 || c.valid < 0 || c.expire < 0)
        return [];

    const leases: Lease[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "")
            continue;
        const f = line.split(",");
        const field = (index: number) => index < 0 ? undefined : f[index];
        const text = (index: number) => {
            const v = nonEmpty(field(index));
            return v === null ? null : unescapeField(v);
        };

        const address = nonEmpty(field(c.address));
        const valid = parseIntOr(field(c.valid), null);
        const expire = parseIntOr(field(c.expire), null);
        if (address === null || valid === null || expire === null)
            continue;

        const leaseType = family === 6 ? parseIntOr(field(c.leaseType), LEASE_TYPE_NA) : LEASE_TYPE_NA;
        const infinite = valid === INFINITE_LIFETIME;

        leases.push({
            family,
            address,
            prefixLen: leaseType === LEASE_TYPE_PD ? parseIntOr(field(c.prefixLen), null) : null,
            leaseType,
            hwaddr: nonEmpty(field(c.hwaddr))?.toLowerCase() ?? null,
            clientId: nonEmpty(field(c.clientId))?.toLowerCase() ?? null,
            duid: nonEmpty(field(c.duid))?.toLowerCase() ?? null,
            hostname: normalizeHostname(text(c.hostname)),
            subnetId: parseIntOr(field(c.subnet), null),
            validLifetime: valid,
            // the CSV stores the expiry; the lease (or its last renewal) started
            // valid_lifetime before that
            start: (infinite ? expire : expire - valid) * 1000,
            expire: infinite ? null : expire * 1000,
            state: parseIntOr(field(c.state), STATE_DEFAULT),
            userContext: parseUserContext(text(c.userContext)),
        });
    }
    return leases;
}

/*
 * Merge rows from the lease files, oldest file first, into the current
 * leases: the last row for an address wins, and valid_lifetime 0 deletes.
 */
export function mergeLeases(rows: Lease[][]): Lease[] {
    const current = new Map<string, Lease>();
    for (const file of rows) {
        for (const lease of file) {
            const key = leaseKey(lease);
            if (lease.validLifetime === 0)
                current.delete(key);
            else
                current.set(key, lease);
        }
    }
    return [...current.values()];
}

/* The suffixes of a memfile's files, in the order to read them */
export const LEASE_FILE_SUFFIXES = [".2", ".1", ""];

/* --- config ------------------------------------------------------------ */

/*
 * Remove #, // and C-style comments outside strings, keeping line breaks so
 * JSON.parse error positions still roughly match the file.
 */
export function stripJsonComments(text: string): string {
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '"') {
            const start = i++;
            while (i < n && text[i] !== '"') {
                if (text[i] === "\\")
                    i++;
                i++;
            }
            i++;
            out += text.slice(start, i);
        } else if (ch === "#" || (ch === "/" && text[i + 1] === "/")) {
            while (i < n && text[i] !== "\n")
                i++;
        } else if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
                if (text[i] === "\n")
                    out += "\n";
                i++;
            }
            i += 2;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

export interface Reservation {
    family: Family;
    hwaddr: string | null;
    duid: string | null;
    clientId: string | null;
    addresses: string[]; // ip-address (v4), ip-addresses and prefixes (v6, without length)
    hostname: string | null;
    description: string | null;
}

export interface LeaseDatabase {
    type: string;
    /* lease file path, for memfile */
    name: string | null;
}

export interface KeaConfig {
    leaseDatabase: LeaseDatabase;
    reservations: Reservation[];
    includes: boolean; // config uses <?include?>, which this page doesn't follow
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
    return typeof v === "string" && v !== "" ? v : null;
}

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/* Kea turns "comment" into user-context.comment; accept common keys from both */
export function descriptionOf(obj: JsonObject | null): string | null {
    if (!obj)
        return null;
    const ctx = isObject(obj["user-context"]) ? obj["user-context"] : {};
    for (const v of [obj.comment, ctx.description, ctx.comment, obj.description])
        if (str(v))
            return str(v);
    return null;
}

function reservationsIn(family: Family, container: JsonObject): Reservation[] {
    return arr(container.reservations).filter(isObject)
            .map(r => {
                const addresses = family === 4
                    ? [str(r["ip-address"])]
                    : [...arr(r["ip-addresses"]), ...arr(r.prefixes)].map(a => str(a)?.split("/")[0] ?? null);
                return {
                    family,
                    hwaddr: str(r["hw-address"])?.toLowerCase() ?? null,
                    duid: str(r.duid)?.toLowerCase() ?? null,
                    clientId: str(r["client-id"])?.toLowerCase() ?? null,
                    addresses: addresses.filter((a): a is string => a !== null).map(a => a.toLowerCase()),
                    hostname: str(r.hostname),
                    description: descriptionOf(r),
                };
            });
}

/* Parse kea-dhcp4.conf / kea-dhcp6.conf. Throws on invalid JSON. */
export function parseConfig(family: Family, text: string): KeaConfig {
    const root = JSON.parse(stripJsonComments(text.replace(/<\?include\s+"[^"]*"\s*\?>/g, "")));
    const server = isObject(root) ? root[family === 4 ? "Dhcp4" : "Dhcp6"] : null;
    if (!isObject(server))
        throw new Error(`no "Dhcp${family}" object`);

    const db = isObject(server["lease-database"]) ? server["lease-database"] : {};
    const subnetKey = family === 4 ? "subnet4" : "subnet6";
    const subnets = [
        ...arr(server[subnetKey]),
        ...arr(server["shared-networks"]).filter(isObject)
                .flatMap(n => arr(n[subnetKey])),
    ].filter(isObject);

    return {
        leaseDatabase: {
            type: str(db.type) ?? "memfile",
            name: str(db.name),
        },
        reservations: [server, ...subnets].flatMap(c => reservationsIn(family, c)),
        includes: /<\?include/.test(text),
    };
}

/* Kea's built-in default (Debian builds use localstatedir /var) */
export function defaultLeaseFile(family: Family): string {
    return `/var/lib/kea/kea-leases${family}.csv`;
}

/* The reservation that a lease was most likely given for */
export function findReservation(lease: Lease, reservations: Reservation[]): Reservation | null {
    const candidates = reservations.filter(r => r.family === lease.family);
    const address = lease.address.toLowerCase();
    return candidates.find(r => r.addresses.includes(address)) ??
        candidates.find(r => (r.hwaddr && r.hwaddr === lease.hwaddr) ||
                             (r.duid && r.duid === lease.duid) ||
                             (r.clientId && r.clientId === lease.clientId)) ??
        null;
}

/* --- display helpers --------------------------------------------------- */

/* Sort key so addresses sort numerically, IPv4 before IPv6 */
export function addressSortKey(lease: Lease): string {
    if (lease.family === 4)
        return "4" + lease.address.split(".").map(o => o.padStart(3, "0"))
                .join(".");
    return "6" + expandIPv6(lease.address) + "/" + String(lease.prefixLen ?? 128).padStart(3, "0");
}

export function expandIPv6(address: string): string {
    let addr = address.toLowerCase();
    // embedded IPv4, e.g. ::ffff:192.0.2.1
    const v4 = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (v4) {
        const [a, b, c, d] = v4.slice(1).map(Number);
        addr = addr.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
    }
    const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, null];
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return groups.map(g => g.padStart(4, "0")).join(":");
}
