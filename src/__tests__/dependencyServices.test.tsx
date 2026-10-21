import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { serviceLines } from "../components/DependenciesPanel";
import { DependencyRunConfirm } from "../components/ProgramPrompts";

describe("serviceLines", () => {
  const name = (id: string) => (id === "slskd" ? "Soulseek" : id);
  const time = () => "10:42";

  it("names the plugin running the tool and since when", () => {
    expect(serviceLines([{ pluginId: "slskd", name: "slskd", running: true, startedAt: 1 }], name, time)).toEqual([
      { running: true, text: "Running · started by Soulseek · since 10:42" },
    ]);
  });

  it("says a registered service isn't running, and nothing without one", () => {
    expect(serviceLines([{ pluginId: "slskd", name: "slskd", running: false, startedAt: null }], name, time)).toEqual([
      { running: false, text: "Not running · Soulseek" },
    ]);
    expect(serviceLines(undefined, name, time)).toEqual([]);
  });
});

describe("DependencyRunConfirm", () => {
  it("names the tool, its version and source, and defaults to not allowing", () => {
    const onAllow = vi.fn();
    const onCancel = vi.fn();
    render(
      <DependencyRunConfirm
        pluginName="Soulseek"
        dependency="slskd"
        version="0.27.0"
        repo="slskd/slskd"
        onAllow={onAllow}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("Run slskd in the background?")).toBeTruthy();
    expect(screen.getByText(/slskd 0\.27\.0 \(from slskd\/slskd\)/)).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Don't allow");
    fireEvent.click(screen.getByText("Allow"));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
