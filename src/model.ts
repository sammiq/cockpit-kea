/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Read-only model of Kea's current leases, from its memfile lease files
 * (see kea.ts). Both /etc/kea and /var/lib/kea are readable by _kea only,
 * so all files are read with superuser "try": with limited access the
 * reads fail and the page says administrative access is needed.
 *
 * Each server's config is watched for the lease file location and the host
 * reservations (for descriptions); the lease files are watched for changes
 * and re-parsed. Kea appends to them on every lease change, so updates come
 * in bursts; they are coalesced.
 */

import cockpit from 'cockpit';

import {
    defaultLeaseFile, findReservation, LEASE_FILE_SUFFIXES, mergeLeases, parseConfig, parseLeaseFile, descriptionOf,
} from './kea';
import type { Family, KeaConfig, Lease, Reservation } from './kea';

const _ = cockpit.gettext;

export const CONFIG_FILES: Record<Family, string> = {
    4: "/etc/kea/kea-dhcp4.conf",
    6: "/etc/kea/kea-dhcp6.conf",
};

const UPDATE_DEBOUNCE = 200;
// Lease files of a busy server can get big between cleanups
const MAX_LEASE_FILE_SIZE = 256 * 1024 * 1024;

export interface DisplayLease extends Lease {
    key: string;
    description: string | null;
    reservation: Reservation | null;
    /* hostname not from this lease, but from the reservation or another
     * lease of the same MAC address (DHCPv6 clients often send none) */
    hostnameInferred: boolean;
}

export interface FamilyInfo {
    family: Family;
    configFound: boolean;
    configError: string | null;
    /* null while the config is loading */
    leaseFile: string | null;
    /* lease backend when it isn't memfile (mysql, postgresql) */
    unsupportedBackend: string | null;
    includes: boolean;
    leaseFileFound: boolean;
}

export interface ModelState {
    loading: boolean;
    accessDenied: boolean;
    /* read errors other than access denied */
    errors: string[];
    families: Record<Family, FamilyInfo>;
    leases: DisplayLease[];
}

interface ModelEvents extends cockpit.EventMap {
    changed(): void;
}

type FileContent = { loaded: false } | { loaded: true, content: string | null, error: cockpit.BasicError | null };

function isAccessDenied(error: cockpit.BasicError | null): boolean {
    return !!error && (error.problem === "access-denied" || error.problem === "not-authorized");
}

function errorMessage(path: string, error: cockpit.BasicError): string {
    return cockpit.format(_("Cannot read $0: $1"), path, error.message || error.problem || String(error));
}

class FamilyWatcher {
    family: Family;
    private onChange: () => void;
    private configHandle: cockpit.FileHandle<string>;
    private config: FileContent = { loaded: false };
    parsed: KeaConfig | null = null;
    configError: string | null = null;
    leaseFile: string | null = null;
    private leaseHandles: { path: string, handle: cockpit.FileHandle<string>, content: FileContent }[] = [];

    constructor(family: Family, onChange: () => void) {
        this.family = family;
        this.onChange = onChange;
        this.configHandle = cockpit.file(CONFIG_FILES[family], { superuser: "try" });
        this.configHandle.watch((content, _tag, error) => {
            this.config = { loaded: true, content, error };
            this.parseConfig();
            this.onChange();
        });
    }

    private parseConfig() {
        if (!this.config.loaded)
            return;
        const { content, error } = this.config;
        this.parsed = null;
        this.configError = null;
        if (content !== null && !error) {
            try {
                this.parsed = parseConfig(this.family, content);
            } catch (ex) {
                this.configError = cockpit.format(_("Cannot parse $0: $1"), CONFIG_FILES[this.family], String((ex as Error).message ?? ex));
            }
        }

        // Without a readable config, still try Kea's default lease file
        const db = this.parsed?.leaseDatabase;
        const file = db && db.type !== "memfile" ? null : (db?.name ?? defaultLeaseFile(this.family));
        this.setLeaseFile(file);
    }

    private setLeaseFile(file: string | null) {
        if (file === this.leaseFile && (file === null || this.leaseHandles.length > 0))
            return;
        this.closeLeaseFiles();
        this.leaseFile = file;
        if (file === null)
            return;
        this.leaseHandles = LEASE_FILE_SUFFIXES.map(suffix => {
            const path = file + suffix;
            const handle = cockpit.file(path, { superuser: "try", max_read_size: MAX_LEASE_FILE_SIZE });
            const entry = { path, handle, content: { loaded: false } as FileContent };
            handle.watch((content, _tag, error) => {
                entry.content = { loaded: true, content, error };
                this.onChange();
            });
            return entry;
        });
    }

    private closeLeaseFiles() {
        for (const { handle } of this.leaseHandles)
            handle.close();
        this.leaseHandles = [];
    }

    get loaded(): boolean {
        return this.config.loaded && this.leaseHandles.every(h => h.content.loaded);
    }

    get errors(): cockpit.BasicError[] {
        const all = [this.config, ...this.leaseHandles.map(h => h.content)];
        return all.flatMap(c => c.loaded && c.error ? [c.error] : []);
    }

    errorMessages(): string[] {
        const msgs: string[] = [];
        if (this.config.loaded && this.config.error && !isAccessDenied(this.config.error))
            msgs.push(errorMessage(CONFIG_FILES[this.family], this.config.error));
        for (const h of this.leaseHandles)
            if (h.content.loaded && h.content.error && !isAccessDenied(h.content.error))
                msgs.push(errorMessage(h.path, h.content.error));
        return msgs;
    }

    leases(): Lease[] {
        return mergeLeases(this.leaseHandles.map(h =>
            h.content.loaded && h.content.content ? parseLeaseFile(this.family, h.content.content) : []));
    }

    info(): FamilyInfo {
        const db = this.parsed?.leaseDatabase;
        return {
            family: this.family,
            configFound: this.config.loaded && this.config.content !== null,
            configError: this.configError,
            leaseFile: this.leaseFile,
            unsupportedBackend: db && db.type !== "memfile" ? db.type : null,
            includes: this.parsed?.includes ?? false,
            leaseFileFound: this.leaseHandles.some(h => h.content.loaded && h.content.content !== null),
        };
    }

    close() {
        this.configHandle.close();
        this.closeLeaseFiles();
    }
}

class KeaModelBase {
    state: ModelState;
    private watchers: Record<Family, FamilyWatcher>;
    private timer: number | null = null;
    private closed = false;

    constructor() {
        const schedule = () => this.schedule();
        this.watchers = { 4: new FamilyWatcher(4, schedule), 6: new FamilyWatcher(6, schedule) };
        this.state = this.compute();
    }

    private schedule() {
        if (this.timer === null && !this.closed) {
            this.timer = window.setTimeout(() => {
                this.timer = null;
                this.state = this.compute();
                (this as unknown as cockpit.EventSource<ModelEvents>).dispatchEvent("changed");
            }, UPDATE_DEBOUNCE);
        }
    }

    private compute(): ModelState {
        const watchers = [this.watchers[4], this.watchers[6]];
        const loading = watchers.some(w => !w.loaded);
        const accessDenied = watchers.some(w => w.errors.some(isAccessDenied));
        const reservations = watchers.flatMap(w => w.parsed?.reservations ?? []);

        const all = watchers.flatMap(w => w.leases());

        // Hostnames by MAC address, newest lease first
        const hostnames = new Map<string, string>();
        for (const lease of [...all].sort((a, b) => a.start - b.start))
            if (lease.hwaddr && lease.hostname)
                hostnames.set(lease.hwaddr, lease.hostname);

        const leases = all.map(lease => {
            const reservation = findReservation(lease, reservations);
            const hostname = lease.hostname ??
                reservation?.hostname ??
                (lease.hwaddr ? hostnames.get(lease.hwaddr) : undefined) ??
                null;
            return {
                ...lease,
                key: `${lease.family}/${lease.leaseType}/${lease.address}/${lease.prefixLen ?? ""}`,
                reservation,
                hostname,
                hostnameInferred: lease.hostname === null && hostname !== null,
                description: descriptionOf(lease.userContext) ?? reservation?.description ?? null,
            };
        });

        return {
            loading,
            accessDenied,
            errors: watchers.flatMap(w => w.errorMessages()),
            families: { 4: this.watchers[4].info(), 6: this.watchers[6].info() },
            leases,
        };
    }

    close() {
        this.closed = true;
        if (this.timer !== null)
            window.clearTimeout(this.timer);
        this.watchers[4].close();
        this.watchers[6].close();
    }
}

export type KeaModel = KeaModelBase & cockpit.EventSource<ModelEvents>;

export function createModel(): KeaModel {
    return cockpit.event_target<KeaModelBase, ModelEvents>(new KeaModelBase());
}
