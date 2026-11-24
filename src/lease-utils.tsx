/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Shared by the overview (leases-card.tsx) and the lease page
 * (lease-page.tsx): formatting, page paths, and the Kea log units.
 */

import React, { useEffect, useState } from 'react';

import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { LockIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { SuperuserButton } from 'superuser-dialogs';
import * as timeformat from 'timeformat';
import { EmptyStatePanel } from 'cockpit-components-empty-state.jsx';

import {
    LEASE_TYPE_NA, LEASE_TYPE_PD, LEASE_TYPE_TA, STATE_DECLINED, STATE_DEFAULT, STATE_EXPIRED_RECLAIMED,
    STATE_RELEASED,
} from './kea';
import type { DisplayLease } from './model';

const _ = cockpit.gettext;

/* --- time ---------------------------------------------------------------- */

// Leases expire while the page is open; re-check every so often
const TICK_INTERVAL = 15000;

export function useNow(): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

/* Compact for the table: no year when it's this year */
export function formatTimeShort(t: number, now: number): string {
    return new Date(t).getFullYear() === new Date(now).getFullYear()
        ? timeformat.dateTimeNoYear(t)
        : timeformat.dateTime(t);
}

export function formatDuration(seconds: number): string {
    if (seconds % 86400 === 0)
        return cockpit.format(cockpit.ngettext("$0 day", "$0 days", seconds / 86400), seconds / 86400);
    if (seconds % 3600 === 0)
        return cockpit.format(cockpit.ngettext("$0 hour", "$0 hours", seconds / 3600), seconds / 3600);
    if (seconds % 60 === 0)
        return cockpit.format(cockpit.ngettext("$0 minute", "$0 minutes", seconds / 60), seconds / 60);
    return cockpit.format(cockpit.ngettext("$0 second", "$0 seconds", seconds), seconds);
}

/* --- lease state and type ------------------------------------------------ */

export function isCurrent(lease: DisplayLease, now: number): boolean {
    return lease.state === STATE_DEFAULT && (lease.expire === null || lease.expire > now);
}

/* A label for anything but an active lease */
export function stateLabel(lease: DisplayLease, now: number): React.ReactNode {
    switch (lease.state) {
    case STATE_DECLINED:
        return <Label isCompact status="warning">{_("Declined")}</Label>;
    case STATE_EXPIRED_RECLAIMED:
        return <Label isCompact>{_("Expired")}</Label>;
    case STATE_RELEASED:
        return <Label isCompact>{_("Released")}</Label>;
    }
    if (lease.expire !== null && lease.expire <= now)
        return <Label isCompact>{_("Expired")}</Label>;
    return null;
}

export function stateText(lease: DisplayLease, now: number): string {
    switch (lease.state) {
    case STATE_DECLINED: return _("Declined (the client reported an address conflict)");
    case STATE_EXPIRED_RECLAIMED: return _("Expired, reclaimed by the server");
    case STATE_RELEASED: return _("Released by the client");
    }
    return isCurrent(lease, now) ? _("Active") : _("Expired");
}

export function leaseTypeText(lease: DisplayLease): string {
    if (lease.family === 4)
        return _("DHCPv4 address");
    if (lease.leaseType === LEASE_TYPE_PD)
        return _("DHCPv6 delegated prefix");
    if (lease.leaseType === LEASE_TYPE_TA)
        return _("DHCPv6 temporary address");
    return _("DHCPv6 address");
}

export function formatAddress(lease: DisplayLease): string {
    return lease.leaseType === LEASE_TYPE_PD ? `${lease.address}/${lease.prefixLen ?? "?"}` : lease.address;
}

/* --- small components ---------------------------------------------------- */

export const Subtle = ({ children }: { children: React.ReactNode }) =>
    <span className="kea-subtle">{children}</span>;

export const None = () => <Subtle>—</Subtle>;

export const Hostname = ({ lease }: { lease: DisplayLease }) => {
    if (lease.hostname === null)
        return <None />;
    if (!lease.hostnameInferred)
        return <span>{lease.hostname}</span>;
    return (
        <span className="kea-subtle" title={_("The client sent no hostname; this is from its host reservation or another lease with the same MAC address")}>
            {lease.hostname}
        </span>
    );
};

export const AccessDenied = () => (
    <EmptyStatePanel
        icon={LockIcon}
        title={_("Administrative access is required to view leases")}
        paragraph={_("Kea's configuration and lease files are only readable by the _kea user and root.")}
        action={<SuperuserButton />}
    />
);

/* --- lease pages --------------------------------------------------------- */

/*
 * A lease's page: #/<address> for DHCPv4 and DHCPv6 addresses (their
 * formats can't clash), #/ta/<address> for temporary addresses, and
 * #/prefix/<address>/<length> for delegated prefixes.
 */
export function leasePath(lease: DisplayLease): string[] {
    if (lease.leaseType === LEASE_TYPE_PD)
        return ["prefix", lease.address, String(lease.prefixLen ?? "")];
    if (lease.leaseType === LEASE_TYPE_TA)
        return ["ta", lease.address];
    return [lease.address];
}

export function findLease(leases: DisplayLease[], path: string[]): DisplayLease | undefined {
    const [first, address, len] = path;
    if (first === "prefix")
        return leases.find(l => l.leaseType === LEASE_TYPE_PD && l.address === address && String(l.prefixLen) === len);
    if (first === "ta")
        return leases.find(l => l.leaseType === LEASE_TYPE_TA && l.address === address);
    return path.length === 1 ? leases.find(l => l.leaseType === LEASE_TYPE_NA && l.address === first) : undefined;
}

export const LeaseLink = ({ lease }: { lease: DisplayLease }) => (
    <Button variant="link" isInline className="kea-address" onClick={() => cockpit.location.go(leasePath(lease))}>
        {formatAddress(lease)}
    </Button>
);

/* --- logs ---------------------------------------------------------------- */

// Debian's unit names, then those of ISC's own packages
const KEA_UNITS = [
    "kea-dhcp4-server", "kea-dhcp6-server", "kea-dhcp-ddns-server", "kea-ctrl-agent",
    "isc-kea-dhcp4-server", "isc-kea-dhcp6-server", "isc-kea-dhcp-ddns-server", "isc-kea-ctrl-agent",
];

// Messages from the daemons, plus systemd's own about them (started,
// failed, ...), like the logs page's "service:" filter
export const LOG_MATCH = [
    ...KEA_UNITS.map(u => "_SYSTEMD_UNIT=" + u + ".service"),
    "+",
    ...KEA_UNITS.map(u => "UNIT=" + u + ".service"),
];

/* Cockpit's Logs page for the Kea units, optionally searching for text */
export function logsUrl(grep?: string): string {
    const options: Record<string, string> = { prio: "info", service: KEA_UNITS.join(",") };
    if (grep)
        options.grep = grep;
    return "/system/logs/#/?" + Object.entries(options)
            .map(([k, v]) => k + "=" + encodeURIComponent(v).replace(/%2C/g, ","))
            .join("&");
}
