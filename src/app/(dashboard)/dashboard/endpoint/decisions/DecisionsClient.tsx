"use client";

import ApiTab from "../../playground/components/tabs/ApiTab";

/** The Decisions shortcut uses the same endpoint/provider/model/account editor as every API. */
export default function DecisionsClient({
  embedded = false,
  onEndpointChange,
}: {
  embedded?: boolean;
  onEndpointChange?: (endpoint: string) => void;
}) {
  return (
    <div className="min-w-0">
      {!embedded && (
        <a href="/dashboard/endpoint" className="text-action hover:underline">
          Back to endpoints
        </a>
      )}
      <ApiTab initialEndpoint="decisions" onEndpointChange={onEndpointChange} />
    </div>
  );
}
