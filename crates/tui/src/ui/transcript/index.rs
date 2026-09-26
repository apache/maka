/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Incremental row totals; measuring one block never shifts every later offset.
#[derive(Default)]
pub(super) struct Rows {
    heights: Vec<usize>,
    sums: Vec<usize>,
}
impl Rows {
    pub fn reset(&mut self, heights: impl Iterator<Item = usize>) {
        self.heights.clear();
        self.heights.extend(heights);
        self.sums.clear();
        self.sums.resize(self.heights.len() + 1, 0);
        for index in 1..self.sums.len() {
            self.sums[index] += self.heights[index - 1];
            let parent = index + index.isolate_lowest_one();
            if parent < self.sums.len() {
                self.sums[parent] += self.sums[index];
            }
        }
    }
    pub fn clear(&mut self) {
        self.heights.clear();
        self.sums.clear();
    }
    pub fn len(&self) -> usize {
        self.heights.len()
    }
    pub fn bytes(&self) -> usize {
        (self.heights.capacity() + self.sums.capacity()) * std::mem::size_of::<usize>()
    }
    pub fn height(&self, index: usize) -> usize {
        self.heights[index]
    }
    pub fn start(&self, mut index: usize) -> usize {
        let mut total = 0;
        while index > 0 {
            total += self.sums[index];
            index &= index - 1;
        }
        total
    }
    pub fn total(&self) -> usize {
        self.start(self.len())
    }
    pub fn set(&mut self, index: usize, height: usize) {
        let previous = std::mem::replace(&mut self.heights[index], height);
        let mut index = index + 1;
        while index < self.sums.len() {
            if height >= previous {
                self.sums[index] += height - previous;
            } else {
                self.sums[index] -= previous - height;
            }
            index += index.isolate_lowest_one();
        }
    }
    pub fn at(&self, row: usize) -> usize {
        if self.heights.is_empty() {
            return 0;
        }
        let mut index = 0;
        let mut total = 0;
        let mut step = self.heights.len().next_power_of_two();
        while step > 0 {
            let next = index + step;
            if next < self.sums.len() && total + self.sums[next] <= row {
                total += self.sums[next];
                index = next;
            }
            step /= 2;
        }
        index.min(self.heights.len() - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updates_and_boundary_seeks_match_explicit_rows() {
        let mut rows = Rows::default();
        let mut heights = [1, 13, 4, 2, 71, 1, 9];
        rows.reset(heights.iter().copied());
        for (changed, height) in [(0, 30), (4, 1), (6, 103), (2, 1)] {
            heights[changed] = height;
            rows.set(changed, height);
            let mut total = 0;
            for (index, height) in heights.iter().copied().enumerate() {
                assert_eq!(rows.start(index), total);
                assert_eq!(rows.height(index), height);
                for offset in 0..height {
                    assert_eq!(rows.at(total + offset), index);
                }
                total += height;
            }
            assert_eq!(rows.total(), total);
            assert_eq!(rows.at(usize::MAX), heights.len() - 1);
        }
        rows.clear();
        assert_eq!(rows.len(), 0);
        assert_eq!(rows.total(), 0);
        rows.reset([3, 1].into_iter());
        assert_eq!(rows.at(3), 1);
    }
}
