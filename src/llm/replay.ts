// Record / replay of LLM responses.
//
// ReplayProvider returns pre-recorded responses in order, ignoring the
// request. Tests use hand-written fixtures to simulate a *misbehaving* model
// (calls unknown tools, sends bad arguments, follows a prompt injection,
// never stops) and check that the guardrails hold.
//
// RecordingProvider wraps any provider and keeps every response, so a real
// run (e.g. with AnthropicProvider) can be saved and replayed offline.
import { readFileSync, writeFileSync } from "node:fs";
import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

export interface Fixture {
  description: string;
  model: string;
  responses: LLMResponse[];
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export class ReplayProvider implements LLMProvider {
  readonly name = "replay";
  readonly model: string;
  private index = 0;

  constructor(private fixture: Fixture) {
    this.model = fixture.model;
  }

  async complete(): Promise<LLMResponse> {
    const response = this.fixture.responses[this.index++];
    if (!response) throw new Error(`Fixture exhausted after ${this.index - 1} responses`);
    return response;
  }
}

export class RecordingProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly responses: LLMResponse[] = [];

  constructor(private inner: LLMProvider) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.complete(request);
    this.responses.push(response);
    return response;
  }

  save(path: string, description: string): void {
    const fixture: Fixture = { description, model: this.model, responses: this.responses };
    writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  }
}
