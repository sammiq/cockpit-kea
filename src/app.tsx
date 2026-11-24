/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * ISC Kea DHCP page. The overview (#/) has the current leases and the Kea
 * services' logs; each lease has its own page (lease-page.tsx). Read-only.
 */

import React, { useState } from 'react';
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Gallery } from '@patternfly/react-core/dist/esm/layouts/Gallery/index.js';

import cockpit from 'cockpit';
import { WithDialogs } from 'dialogs';
import { useEvent, useObject, usePageLocation } from 'hooks';
import { superuser } from 'superuser';
import { LogsPanel } from 'cockpit-components-logs-panel.jsx';

import { createModel } from './model';
import { LeasesCard } from './leases-card';
import type { LeasesView } from './leases-card';
import { LeasePage } from './lease-page';
import { LOG_MATCH, logsUrl } from './lease-utils';

const _ = cockpit.gettext;

export const Application = () => {
    useEvent(superuser, "changed");
    // Re-read everything when administrative access is turned on or off
    const model = useObject(createModel, model => model.close(), [superuser.allowed] as const);
    useEvent(model, "changed");

    const [view, setView] = useState<LeasesView>({ filter: "", showAll: false });
    const { path } = usePageLocation();

    return (
        <WithDialogs>
            {path.length > 0
                ? <LeasePage state={model.state} path={path} />
                : (
                    <Page id="kea" className="pf-m-no-sidebar">
                        <PageSection hasBodyWrapper={false}>
                            <Gallery hasGutter>
                                <LeasesCard state={model.state} view={view} setView={setView} />
                                <LogsPanel
                                    title={_("Kea logs")}
                                    match={LOG_MATCH}
                                    max={10}
                                    search_options={{ prio: "info" }}
                                    goto_url={logsUrl()}
                                    emptyMessage={_("No log entries")}
                                    className="contains-list"
                                />
                            </Gallery>
                        </PageSection>
                    </Page>
                )}
        </WithDialogs>
    );
};
