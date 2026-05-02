import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { buildLatestStateMap } from "../core/backlog.ts";
import { loadRemoteTasks, resolveTaskConflict } from "../core/task-loader.ts";
import type { BranchTaskStateEntry } from "../core/task-loader.ts";
import type { GitOperations } from "../git/operations.ts";
import type { Task } from "../types/index.ts";

// Mock GitOperations for testing
class MockGitOperations implements Partial<GitOperations> {
	async fetch(): Promise<void> {
		// Mock fetch
	}

	async listRemoteBranches(): Promise<string[]> {
		return ["main", "feature", "feature2"];
	}

	async listRecentRemoteBranches(_daysAgo: number): Promise<string[]> {
		return ["main", "feature", "feature2"];
	}

	async getBranchLastModifiedMap(_ref: string, _dir: string): Promise<Map<string, Date>> {
		const map = new Map<string, Date>();
		// Add all files with the same date for simplicity
		map.set("backlog/tasks/task-1 - Main Task.md", new Date("2025-06-13"));
		map.set("backlog/tasks/task-2 - Feature Task.md", new Date("2025-06-13"));
		map.set("backlog/tasks/task-3 - Feature2 Task.md", new Date("2025-06-13"));
		return map;
	}

	async listFilesInTree(ref: string, _path: string): Promise<string[]> {
		if (ref === "origin/main") {
			return ["backlog/tasks/task-1 - Main Task.md"];
		}
		if (ref === "origin/feature") {
			return ["backlog/tasks/task-2 - Feature Task.md"];
		}
		if (ref === "origin/feature2") {
			return ["backlog/tasks/task-3 - Feature2 Task.md"];
		}
		return [];
	}

	async showFile(_ref: string, file: string): Promise<string> {
		if (file.includes("task-1")) {
			return `---
id: task-1
title: Main Task
status: To Do
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nMain task`;
		}
		if (file.includes("task-2")) {
			return `---
id: task-2
title: Feature Task
status: In Progress
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nFeature task`;
		}
		if (file.includes("task-3")) {
			return `---
id: task-3
title: Feature2 Task
status: Done
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nFeature2 task`;
		}
		return "";
	}

	async getFileLastModifiedTime(_ref: string, _file: string): Promise<Date | null> {
		return new Date("2025-06-13");
	}
}

describe("Parallel remote task loading", () => {
	let consoleErrorSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		consoleErrorSpy = spyOn(console, "error");
	});

	afterEach(() => {
		consoleErrorSpy?.mockRestore();
	});

	it("should load tasks from multiple branches in parallel", async () => {
		const mockGitOperations = new MockGitOperations() as unknown as GitOperations;

		// Track progress messages
		const progressMessages: string[] = [];
		const remoteTasks = await loadRemoteTasks(mockGitOperations, null, (msg: string) => {
			progressMessages.push(msg);
		});

		// Verify results - we should have tasks from all remote branches
		expect(remoteTasks.length).toBe(3);
		const taskIds = remoteTasks.map((t) => t.id);
		expect(taskIds).toContain("TASK-1");
		expect(taskIds).toContain("TASK-2");
		expect(taskIds).toContain("TASK-3");

		// Verify each task has correct metadata
		const task1 = remoteTasks.find((t) => t.id === "TASK-1");
		expect(task1?.source).toBe("remote");
		expect(task1?.branch).toBe("main");
		expect(task1?.status).toBe("To Do");

		// Verify progress reporting
		expect(progressMessages.some((msg) => msg.includes("Fetching remote branches"))).toBe(true);
		expect(progressMessages.some((msg) => msg.includes("Found 3 unique tasks across remote branches"))).toBe(true);
		expect(progressMessages.some((msg) => msg.includes("Loaded 3 remote tasks"))).toBe(true);
	});

	it("should handle errors gracefully", async () => {
		// Create a mock that throws an error
		const errorGitOperations = {
			fetch: async () => {
				throw new Error("Network error");
			},
			listRecentRemoteBranches: async (_daysAgo: number) => {
				throw new Error("Network error");
			},
		} as unknown as GitOperations;

		// Should return empty array on error
		const remoteTasks = await loadRemoteTasks(errorGitOperations, null);
		expect(remoteTasks).toEqual([]);

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to fetch remote tasks:", expect.any(Error));
	});

	it("should resolve task conflicts correctly", async () => {
		const statuses = ["To Do", "In Progress", "Done"];

		const localTask: Task = {
			id: "task-1",
			title: "Local Task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-13",
			labels: [],
			dependencies: [],
			description: "Local version",
			source: "local",
			lastModified: new Date("2025-06-13T10:00:00Z"),
		};

		const remoteTask: Task = {
			id: "task-1",
			title: "Remote Task",
			status: "Done",
			assignee: [],
			createdDate: "2025-06-13",
			labels: [],
			dependencies: [],
			description: "Remote version",
			source: "remote",
			branch: "feature",
			lastModified: new Date("2025-06-13T12:00:00Z"),
		};

		// Test most_progressed strategy - should pick Done over To Do
		const resolved1 = resolveTaskConflict(localTask, remoteTask, statuses, "most_progressed");
		expect(resolved1.status).toBe("Done");
		expect(resolved1.title).toBe("Remote Task");

		// Test most_recent strategy - should pick the more recent one
		const resolved2 = resolveTaskConflict(localTask, remoteTask, statuses, "most_recent");
		expect(resolved2.lastModified).toEqual(new Date("2025-06-13T12:00:00Z"));
		expect(resolved2.title).toBe("Remote Task");
	});
});

describe("buildLatestStateMap", () => {
	it("completed state beats task state regardless of timestamp", () => {
		const completedEntry: BranchTaskStateEntry = {
			id: "task-1",
			type: "completed",
			lastModified: new Date("2025-01-01"),
			branch: "feature",
			path: "backlog/completed/task-1 - Test.md",
		};

		const localTasks = [
			{
				id: "task-1",
				title: "Test",
				status: "In Progress",
				assignee: [],
				createdDate: "2025-06-01",
				labels: [],
				dependencies: [],
				lastModified: new Date("2025-06-01"),
			} as Task & { lastModified: Date },
		];

		const result = buildLatestStateMap([completedEntry], localTasks);
		expect(result.get("task-1")?.type).toBe("completed");
	});

	it("archived state beats task state regardless of timestamp", () => {
		const archivedEntry: BranchTaskStateEntry = {
			id: "task-2",
			type: "archived",
			lastModified: new Date("2025-01-01"),
			branch: "feature",
			path: "backlog/archive/tasks/task-2 - Test.md",
		};

		const localTasks = [
			{
				id: "task-2",
				title: "Test",
				status: "In Progress",
				assignee: [],
				createdDate: "2025-06-01",
				labels: [],
				dependencies: [],
				lastModified: new Date("2025-06-01"),
			} as Task & { lastModified: Date },
		];

		const result = buildLatestStateMap([archivedEntry], localTasks);
		expect(result.get("task-2")?.type).toBe("archived");
	});
});
