import { ApiPromise } from '@polkadot/api';
import { BlockHash } from '@polkadot/types/interfaces';
import { isHex } from '@polkadot/util';
import { RequestHandler, Response, Router } from 'express';
import * as express from 'express';
import { BadRequest, HttpError, InternalServerError } from 'http-errors';
import { AbstractService } from 'src/services/AbstractService';
import { AnyJson } from 'src/types/polkadot-js';
import {
	IAddressNumberParams,
	IAddressParam,
	INumberParam,
} from 'src/types/requests';

import { sanitizeNumbers } from '../sanitize';
import { isBasicLegacyError } from '../types/errors';

type SidecarRequestHandler =
	| RequestHandler<IAddressParam>
	| RequestHandler<IAddressNumberParams>
	| RequestHandler<INumberParam>
	| RequestHandler;

/**
 * Abstract base class for creating controller classes.
 */
export default abstract class AbstractController<T extends AbstractService | undefined> {
	private _router: Router = express.Router();
	constructor(
		protected api: ApiPromise,
		private _path: string,
		protected service: T
	) {}

	get path(): string {
		return this._path;
	}

	get router(): Router {
		return this._router;
	}

	/**
	 * Mount all controller handler methods on the class's private router.
	 *
	 * Keep in mind that asynchronous errors in the RequestHandlers need to be
	 * dealt with manually.
	 */
	protected abstract initRoutes(): void;

	/**
	 * Safely mount async GET routes by wrapping them with an express
	 * handler friendly try / catch block and then mounting on the controllers
	 * router.
	 *
	 * @param pathsAndHandlers array of tuples containing the suffix to the controller
	 * base path (use empty string if no suffix) and the get request handler function.
	 */
	protected safeMountAsyncGetHandlers(
		pathsAndHandlers: [string, SidecarRequestHandler][]
	): void {
		for (const pathAndHandler of pathsAndHandlers) {
			const [pathSuffix, handler] = pathAndHandler;
			this.router.get(
				`${this.path}${pathSuffix}`,
				AbstractController.catchWrap(handler as RequestHandler)
			);
		}
	}

	/**
	 * Wrapper for any asynchronous RequestHandler function. Pipes errors
	 * to downstream error handling middleware.
	 *
	 * @param cb ExpressHandler
	 */
	protected static catchWrap = (cb: RequestHandler): RequestHandler => async (
		req,
		res,
		next
	): Promise<void> => {
		try {
			await cb(req, res, next);
		} catch (err) {
			next(err);
		}
	};

	/**
	 * Create or retrieve the corresponding BlockHash for the given block identifier.
	 * This also acts as a validation for string based block identifiers.
	 *
	 * @param blockId string representing a hash or number block identifier.
	 */
	protected async getHashForBlock(blockId: string): Promise<BlockHash> {
		let blockNumber;

		try {
			const isHexStr = isHex(blockId);
			if (isHexStr && blockId.length === 66) {
				// This is a block hash
				return this.api.createType('BlockHash', blockId);
			} else if (isHexStr) {
				throw new BadRequest(
					`Cannot get block hash for ${blockId}. ` +
						`Hex string block IDs must be 32-bytes (66-characters) in length.`
				);
			} else if (blockId.slice(0, 2) === '0x') {
				throw new BadRequest(
					`Cannot get block hash for ${blockId}. ` +
						`Hex string block IDs must be a valid hex string ` +
						`and must be 32-bytes (66-characters) in length.`
				);
			}

			// Not a block hash, must be a block height
			try {
				blockNumber = this.parseNumberOrThrow(
					blockId,
					'Invalid block number'
				);
			} catch (err) {
				throw new BadRequest(
					`Cannot get block hash for ${blockId}. ` +
						`Block IDs must be either 32-byte hex strings or non-negative decimal integers.`
				);
			}

			return await this.api.rpc.chain.getBlockHash(blockNumber);
		} catch (err) {
			if (err instanceof HttpError) {
				// Throw errors we created in the above try block
				throw err;
			}

			const { number } = await this.api.rpc.chain
				.getHeader()
				.catch(() => {
					throw new InternalServerError(
						'Failed while trying to get the latest header.'
					);
				});
			if (blockNumber && number.toNumber() < blockNumber) {
				throw new BadRequest(
					`Specified block number is larger than the current largest block. ` +
						`The largest known block number is ${number.toString()}.`
				);
			}

			// This should never be used, but here just in case
			if (isBasicLegacyError(err)) {
				throw err;
			}

			throw new InternalServerError(
				`Cannot get block hash for ${blockId}.`
			);
		}
	}

	protected parseNumberOrThrow(n: string, errorMessage: string): number {
		const num = Number(n);

		if (!Number.isInteger(num) || num < 0) {
			throw new BadRequest(errorMessage);
		}

		return num;
	}

	protected verifyAndCastOr(
		name: string,
		str: unknown,
		or: number | undefined
	): number | undefined {
		if (!str) {
			return or;
		}

		if (!(typeof str === 'string')) {
			throw new BadRequest(
				`Incorrect argument quantity or type passed in for ${name} query param`
			);
		}

		return this.parseNumberOrThrow(
			str,
			`${name} query param is an invalid number`
		);
	}

	/**
	 * Get a BlockHash based on the `at` query param.
	 *
	 * @param at should be a block height, hash, or undefined from the `at` query param
	 */
	protected async getHashFromAt(at: unknown): Promise<BlockHash> {
		return typeof at === 'string'
			? await this.getHashForBlock(at)
			: await this.api.rpc.chain.getFinalizedHead();
	}

	/**
	 * Sanitize the numbers within the response body and then send the response
	 * body using the original Express Response object.
	 *
	 * @param res Response
	 * @param body response body
	 */
	static sanitizedSend<T>(res: Response<AnyJson>, body: T): void {
		res.send(sanitizeNumbers(body));
	}
}
