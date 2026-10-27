/**
 * The avatar store of the Git Graph Extension State (OPTIMIZATION-PLAN §3 A5): the avatar
 * cache (one globalState key) plus the global storage folder the avatar files live in -
 * split out of the former flat platform/storage.ts, over the one versioned KV
 * (./storageVersioned.ts). The `ExtensionState` facade delegates its avatar methods here.
 */

import * as fs from 'fs';
import { Avatar, AvatarCache } from '../integrations/avatars/avatarManager';
import { isStateRecord, VersionedStateKv } from './storageVersioned';

const AVATAR_STORAGE_FOLDER = '/avatars';
const AVATAR_CACHE = 'avatarCache';

/** The avatar cache and avatar storage folder of the Git Graph Extension State. */
export class AvatarStore {
	private avatarStorageAvailable: boolean = false;

	/**
	 * @param kv The versioned KV over the extension's mementos.
	 * @param globalStoragePath The extension's global storage path (path separators normalised).
	 */
	constructor(private readonly kv: VersionedStateKv, private readonly globalStoragePath: string) {
		fs.stat(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
			if (!err) {
				this.avatarStorageAvailable = true;
			} else {
				fs.mkdir(this.globalStoragePath, () => {
					fs.mkdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
						if (!err || err.code === 'EEXIST') {
							// The directory was created, or it already exists
							this.avatarStorageAvailable = true;
						}
					});
				});
			}
		});
	}

	/**
	 * Checks whether the Avatar Storage Folder is available to store avatars.
	 * @returns TRUE => Avatar Storage Folder is available, FALSE => Avatar Storage Folder isn't available.
	 */
	public isAvatarStorageAvailable() {
		return this.avatarStorageAvailable;
	}

	/**
	 * Gets the path that is used to store avatars globally in Git Graph.
	 * @returns The folder path.
	 */
	public getAvatarStoragePath() {
		return this.globalStoragePath + AVATAR_STORAGE_FOLDER;
	}

	/**
	 * Gets the cache of avatars known to Git Graph.
	 * @returns The avatar cache.
	 */
	public getAvatarCache() {
		const avatars = this.kv.readGlobal<AvatarCache>(AVATAR_CACHE, {});
		return isStateRecord(avatars) ? avatars : {};
	}

	/**
	 * Add a new avatar to the cache of avatars known to Git Graph.
	 * @param email The email address that the avatar is for.
	 * @param avatar The details of the avatar.
	 */
	public saveAvatar(email: string, avatar: Avatar) {
		const avatars = this.getAvatarCache();
		avatars[email] = avatar;
		this.kv.writeGlobal(AVATAR_CACHE, avatars);
	}

	/**
	 * Removes an avatar from the cache of avatars known to Git Graph.
	 * @param email The email address of the avatar to remove.
	 */
	public removeAvatarFromCache(email: string) {
		const avatars = this.getAvatarCache();
		delete avatars[email];
		this.kv.writeGlobal(AVATAR_CACHE, avatars);
	}

	/**
	 * Removes multiple avatars from the cache of avatars known to Git Graph, in one state write.
	 * @param emails The email addresses of the avatars to remove.
	 */
	public removeAvatarsFromCache(emails: string[]) {
		if (emails.length === 0) return;
		const avatars = this.getAvatarCache();
		for (let i = 0; i < emails.length; i++) {
			delete avatars[emails[i]];
		}
		this.kv.writeGlobal(AVATAR_CACHE, avatars);
	}

	/**
	 * Clear all avatars from the cache of avatars known to Git Graph.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from executing this method.
	 */
	public clearAvatarCache() {
		return this.kv.writeGlobal(AVATAR_CACHE, {}).then((errorInfo) => {
			if (errorInfo === null) {
				fs.readdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err, files) => {
					if (err) return;
					for (let i = 0; i < files.length; i++) {
						fs.unlink(this.globalStoragePath + AVATAR_STORAGE_FOLDER + '/' + files[i], () => { });
					}
				});
			}
			return errorInfo;
		});
	}
}
