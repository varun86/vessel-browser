import { Show, type Accessor, type Component } from "solid-js";
import { ExternalLink, PanelRightClose, X } from "lucide-solid";

type SidebarWindowControlsProps = {
  detached: Accessor<boolean>;
  popOut: () => Promise<void>;
  dock: () => Promise<void>;
  close: () => Promise<void>;
};

const SidebarWindowControls: Component<SidebarWindowControlsProps> = (props) => {
  const togglePlacement = () => props.detached() ? props.dock() : props.popOut();
  const placementLabel = () =>
    props.detached() ? "Dock agent panel" : "Pop out agent panel";

  return (
    <>
      <button
        class="sidebar-close"
        onClick={() => void togglePlacement()}
        title={placementLabel()}
        aria-label={placementLabel()}
      >
        <Show
          when={props.detached()}
          fallback={<ExternalLink size={14} aria-hidden="true" />}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </Show>
      </button>
      <Show when={!props.detached()}>
        <button
          class="sidebar-close"
          onClick={() => void props.close()}
          title="Close AI chat (Esc)"
          aria-label="Close AI chat"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </Show>
    </>
  );
};

export default SidebarWindowControls;
