import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Configure Monaco to use locally-bundled workers instead of CDN.
// Without this, the production build tries to fetch workers from jsdelivr.net
// which is blocked by both the CSP and offline environments.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });
