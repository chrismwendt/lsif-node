/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fse from 'fs-extra';
import { validate as validateSchema, ValidationError, ValidatorResult } from 'jsonschema';
import * as LSIF from 'lsif-protocol';
import * as TJS from 'typescript-json-schema';
import { getInVs } from './shared';

const vertices: { [id: string]: Element } = {};
const edges: { [id: string]: Element } = {};
const visited: { [id: string]: boolean } = {};

const errors: Error[] = [];

enum Check {
	vertexBeforeEdge = 0,
	allVerticesUsed,
}
const checks: boolean[] = [true, true];

class Error {
	public element: LSIF.Element;
	public message: string;

	constructor(element: LSIF.Element, message: string) {
		this.element = element;
		this.message = message;
	}

	public print(): void {
		console.error(
			`\n${this.element.type.toUpperCase()} ${this.element.id}: ` +
			`FAIL> ${this.message}\n${JSON.stringify(this.element, undefined, 2)}`,
		);
	}
}

class Element {
	public element: LSIF.Element;
	public valid: boolean;

	constructor(element: LSIF.Element) {
		this.element = element;
		this.valid = true;
	}

	public invalidate(): void {
		this.valid = false;
	}
}

class Statistics {
	public passed: number;
	public failed: number;
	public total: number;

	constructor(passed: number, failed: number) {
		this.passed = passed;
		this.failed = failed;
		this.total = passed + failed;
	}
}

export function validate(toolOutput: LSIF.Element[], ids: string[], protocolPath: string): number {
	readInput(toolOutput);

	checkAllVisited();

	if (fse.pathExistsSync(protocolPath)) {
		checkVertices(toolOutput.filter((e: LSIF.Element) => e.type === 'vertex')
								.map((e: LSIF.Element) => e.id.toString()),
								protocolPath);
		checkEdges(	toolOutput.filter((e: LSIF.Element) => e.type === 'edge')
								.map((e: LSIF.Element) => e.id.toString()),
								protocolPath);
	} else {
		console.warn(`Skipping thorough validation: ${protocolPath} was not found`);
	}

	printOutput(ids);

	return errors.length === 0 ? 0 : 1;
}

function readInput(toolOutput: LSIF.Element[]): void {
	const outputMessage: string = 'Reading input...';
	process.stdout.write(`${outputMessage}\r`);

	for (const object of toolOutput) {
		if (object.type === LSIF.ElementTypes.edge) {
			const edge: LSIF.Edge = object as LSIF.Edge;
			const id: string = edge.id.toString();
			edges[id] = new Element(edge);

			if (edge.outV === undefined) {
				errors.push(new Error(edge, `requires property "outV"`));
				edges[id].invalidate();
			}

			if (!LSIF.Edge.is11(edge) && !LSIF.Edge.is1N(edge)) {
				errors.push(new Error(edge, `requires property "inV" or "inVs"`));
				edges[id].invalidate();
			} else {
				checkVertexBeforeEdge(edge);
			}
		} else if (object.type === 'vertex') {
			vertices[object.id.toString()] = new Element(object);
		} else {
			errors.push(new Error(object, `unknown element type`));
		}
	}

	console.log(`${outputMessage} done`);
}

function checkVertexBeforeEdge(edge: LSIF.Edge): void {
	const inVs = getInVs(edge);
	const outV = edge.outV.toString();

	if (vertices[outV] === undefined ||
		// The following will be true if any id in the inV array is not yet defined in the vertices dictionary
		inVs.map((inV) => vertices[inV] === undefined).reduce((total, curr) => total || curr)) {
		errors.push(new Error(edge, `was emitted before a vertex it refers to`));
		edges[edge.id.toString()].invalidate();
		checks[Check.vertexBeforeEdge] = false;
	}

	inVs.forEach((inV) => {
		visited[inV] = true;
	});
	visited[outV] = true;
}

function checkAllVisited(): void {
	Object.keys(vertices)
	.forEach((key: string) => {
		const vertex: LSIF.Vertex = vertices[key].element as LSIF.Vertex;
		if (!visited[key] && vertex.label !== 'metaData') {
			errors.push(new Error(vertex, `not connected to any other vertex`));
			checks[Check.allVerticesUsed] = false;
			vertices[key].invalidate();
		}
	});
}

function checkVertices(ids: string[], protocolPath: string): void {
	let outputMessage: string | undefined;
	const program: TJS.Program = TJS.getProgramFromFiles([protocolPath]);
	const vertexSchema: TJS.Definition | null = TJS.generateSchema(program, 'Vertex', { required: true });
	let count: number = 1;
	const length: number = ids.length;

	ids.forEach((key: string) => {
		const vertex: LSIF.Vertex = vertices[key].element as LSIF.Vertex;
		outputMessage = `Verifying vertex ${count} of ${length}...`;
		process.stdout.write(`${outputMessage}\r`);
		count++;

		const validation: ValidatorResult = validateSchema(vertex, vertexSchema);
		if (!validation.valid) {
			let errorMessage: string | undefined;
			vertices[key].invalidate();

			if (vertex.label === undefined) {
				errorMessage = `requires property "label"`;
			} else if (!Object.values(LSIF.VertexLabels).includes(vertex.label)) {
				errorMessage = `unknown label`;
			} else {
				try {
					const className: string = vertex.label[0].toUpperCase() + vertex.label.slice(1);
					const specificSchema: TJS.Definition | null = TJS.generateSchema(program, className, { required: true });
					const moreValidation: ValidatorResult | null = validateSchema(vertex, specificSchema);
					errorMessage = '';
					moreValidation.errors.forEach((error: ValidationError, index: number) => {
						if (index > 0) {
							errorMessage += '; ';
						}
						errorMessage += `${error.message}`;
					});
				} catch {
					// Failed to get more details for the error
					errorMessage = 'unable to provide details';
				}
			}
			errors.push(new Error(vertex, errorMessage!));
		}
	});

	if (outputMessage !== undefined) {
		console.log(`${outputMessage} done`);
	}
}

function checkEdges(ids: string[], protocolPath: string): void {
	let outputMessage: string | undefined;
	const program: TJS.Program = TJS.getProgramFromFiles([protocolPath]);
	let count: number = 1;
	const length: number = ids.length;

	const e11Schema = TJS.generateSchema(program, 'E11', { required: true, noExtraProps: true });
	const e1NSchema = TJS.generateSchema(program, 'E1N', { required: true, noExtraProps: true });
	const itemSchema = TJS.generateSchema(program, 'ItemEdge', { required: true, noExtraProps: true });

	ids.forEach((key: string) => {
		const edge: LSIF.Edge = edges[key].element as LSIF.Edge;
		outputMessage = `Verifying edge ${count} of ${length}...`;
		process.stdout.write(`${outputMessage}\r`);
		count++;

		if ((!LSIF.Edge.is11(edge) && !(LSIF.Edge.is1N(edge))) || edge.outV === undefined) {
			// This error was caught before
			return;
		}

		if (edge.label === undefined || !Object.values(LSIF.EdgeLabels).includes(edge.label)) {
			errors.push(new Error(edges[key].element, edge.label ? `requires property "label"` : `unknown label`));
			edges[key].invalidate();
			return;
		}

		let validation: ValidatorResult;
		switch (edge.label) {
			case LSIF.EdgeLabels.item:
				validation = validateSchema(edge, itemSchema);
				break;
			case LSIF.EdgeLabels.contains:
				validation = validateSchema(edge, e1NSchema);
				break;
			default:
				validation = validateSchema(edge, e11Schema);
		}

		const validationErrors: ValidationError[] = validation.errors.filter((error) => error.property === 'instance');
		if (validationErrors.length > 0) {
			edges[key].invalidate();
			let errorMessage: string = '';

			validationErrors.forEach((error: ValidationError, index: number) => {
				if (index > 0) {
					errorMessage += '; ';
				}
				errorMessage += `${error.message}`;
			});

			errors.push(new Error(edges[key].element, errorMessage));
		}
	});

	if (outputMessage !== undefined) {
		console.log(`${outputMessage} done`);
	}
}

function getCheckMessage(check: Check): string {
	switch (check) {
		case Check.vertexBeforeEdge:
			return 'vertices emitted before connecting edges';
		case Check.allVerticesUsed:
			return 'all vertices are used in at least one edge';
		default:
			return 'unexpected check';
	}
}

function printOutput(ids: string[]): void {
	console.log('\nResults:');
	for (let i: number = 0; i < checks.length; i++) {
		console.log(`\t${checks[i] ? 'PASS' : 'FAIL'}> ${getCheckMessage(i)}`);
	}
	console.log();

	const verticesStats: Statistics = getStatistics(vertices, ids);
	console.log(`Vertices:\t${verticesStats.passed} passed, ` +
				`${verticesStats.failed} failed, ${verticesStats.total} total`);

	const edgesStats: Statistics = getStatistics(edges, ids);
	console.log(`Edges:\t\t${edgesStats.passed} passed, ` +
				`${edgesStats.failed} failed, ${edgesStats.total} total`);

	errors.forEach((e: Error) => {
		// Only print error for the elements verified
		if (ids.includes(e.element.id.toString())) {
			e.print();
		}
	});
}

function getStatistics(elements: { [id: string]: Element }, ids: string[]): Statistics {
	let passed: number = 0;
	let failed: number = 0;

	Object.keys(elements).forEach((key: string) => {
		if (ids.includes(key)) {
			const element: Element = elements[key];
			if (element.valid) {
				passed++;
			} else {
				failed++;
			}
		}
	});

	return new Statistics(passed, failed);
}
