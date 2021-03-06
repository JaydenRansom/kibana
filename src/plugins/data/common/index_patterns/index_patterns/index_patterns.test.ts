/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { defaults } from 'lodash';
import { IndexPatternsService } from '.';
import { fieldFormatsMock } from '../../field_formats/mocks';
import { stubbedSavedObjectIndexPattern } from '../../../../../fixtures/stubbed_saved_object_index_pattern';
import { UiSettingsCommon, SavedObjectsClientCommon, SavedObject } from '../types';

const createFieldsFetcher = jest.fn().mockImplementation(() => ({
  getFieldsForWildcard: jest.fn().mockImplementation(() => {
    return new Promise((resolve) => resolve([]));
  }),
  every: jest.fn(),
}));

const fieldFormats = fieldFormatsMock;

let object: any = {};

function setDocsourcePayload(id: string | null, providedPayload: any) {
  object = defaults(providedPayload || {}, stubbedSavedObjectIndexPattern(id));
}

describe('IndexPatterns', () => {
  let indexPatterns: IndexPatternsService;
  let savedObjectsClient: SavedObjectsClientCommon;

  beforeEach(() => {
    savedObjectsClient = {} as SavedObjectsClientCommon;
    savedObjectsClient.find = jest.fn(
      () =>
        Promise.resolve([{ id: 'id', attributes: { title: 'title' } }]) as Promise<
          Array<SavedObject<any>>
        >
    );
    savedObjectsClient.delete = jest.fn(() => Promise.resolve({}) as Promise<any>);
    savedObjectsClient.get = jest.fn().mockImplementation(() => object);
    savedObjectsClient.create = jest.fn();
    savedObjectsClient.update = jest
      .fn()
      .mockImplementation(async (type, id, body, { version }) => {
        if (object.version !== version) {
          throw new Object({
            res: {
              status: 409,
            },
          });
        }
        object.attributes.title = body.title;
        object.version += 'a';
        return {
          id: object.id,
          version: object.version,
        };
      });

    indexPatterns = new IndexPatternsService({
      uiSettings: ({
        get: () => Promise.resolve(false),
        getAll: () => {},
      } as any) as UiSettingsCommon,
      savedObjectsClient: (savedObjectsClient as unknown) as SavedObjectsClientCommon,
      apiClient: createFieldsFetcher(),
      fieldFormats,
      onNotification: () => {},
      onError: () => {},
      onRedirectNoIndexPattern: () => {},
    });
  });

  test('does cache gets for the same id', async () => {
    const id = '1';
    setDocsourcePayload(id, {
      id: 'foo',
      version: 'foo',
      attributes: {
        title: 'something',
      },
    });

    const indexPattern = await indexPatterns.get(id);

    expect(indexPattern).toBeDefined();
    expect(indexPattern).toBe(await indexPatterns.get(id));
  });

  test('savedObjectCache pre-fetches only title', async () => {
    expect(await indexPatterns.getIds()).toEqual(['id']);
    expect(savedObjectsClient.find).toHaveBeenCalledWith({
      type: 'index-pattern',
      fields: ['title'],
      perPage: 10000,
    });
  });

  test('caches saved objects', async () => {
    await indexPatterns.getIds();
    await indexPatterns.getTitles();
    await indexPatterns.getFields(['id', 'title']);
    expect(savedObjectsClient.find).toHaveBeenCalledTimes(1);
  });

  test('can refresh the saved objects caches', async () => {
    await indexPatterns.getIds();
    await indexPatterns.getTitles(true);
    await indexPatterns.getFields(['id', 'title'], true);
    expect(savedObjectsClient.find).toHaveBeenCalledTimes(3);
  });

  test('deletes the index pattern', async () => {
    const id = '1';
    const indexPattern = await indexPatterns.get(id);

    expect(indexPattern).toBeDefined();
    await indexPatterns.delete(id);
    expect(indexPattern).not.toBe(await indexPatterns.get(id));
  });

  test('should handle version conflicts', async () => {
    setDocsourcePayload(null, {
      id: 'foo',
      version: 'foo',
      attributes: {
        title: 'something',
      },
    });

    // Create a normal index patterns
    const pattern = await indexPatterns.make('foo');

    expect(pattern.version).toBe('fooa');

    // Create the same one - we're going to handle concurrency
    const samePattern = await indexPatterns.make('foo');

    expect(samePattern.version).toBe('fooaa');

    // This will conflict because samePattern did a save (from refreshFields)
    // but the resave should work fine
    pattern.title = 'foo2';
    await indexPatterns.save(pattern);

    // This should not be able to recover
    samePattern.title = 'foo3';

    let result;
    try {
      await indexPatterns.save(samePattern);
    } catch (err) {
      result = err;
    }

    expect(result.res.status).toBe(409);
  });
});
