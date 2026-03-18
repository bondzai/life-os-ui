CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text,
	`title` text,
	`description` text,
	`status` text DEFAULT 'todo',
	`priority` text DEFAULT 'medium',
	`tags` text,
	`metadata` text,
	`parentId` text,
	`ownerId` text,
	`visibility` text DEFAULT 'private',
	`dueDate` text,
	`createdAt` text,
	`updatedAt` text
);
--> statement-breakpoint
CREATE TABLE `google_tokens` (
	`userId` text PRIMARY KEY NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`expiresAt` text,
	`calendarId` text
);
--> statement-breakpoint
CREATE TABLE `relations` (
	`id` text PRIMARY KEY NOT NULL,
	`fromId` text,
	`toId` text,
	`type` text
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`entityId` text,
	`recurrence` text,
	`nextDue` text,
	`lastCompleted` text,
	`isActive` integer DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`entityId` text,
	`value` real,
	`unit` text,
	`note` text,
	`timestamp` text,
	`ownerId` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`role` text,
	`pin` text,
	`avatarUrl` text
);
