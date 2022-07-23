// Copyright (c) 2022, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import {Pane} from './pane';
import * as monaco from 'monaco-editor';

import _ from 'underscore';

import {CfgState} from './cfg-view.interfaces';
import {Hub} from '../hub';
import {Container} from 'golden-layout';
import {PaneState} from './pane.interfaces';
import {ga} from '../analytics';

import {AnnotatedCfgDescriptor, AnnotatedNodeDescriptor, CFGResult} from '../../types/compilation/cfg.interfaces';
import {GraphLayoutCore} from '../graph-layout-core';
import * as MonacoConfig from '../monaco-config';
import TomSelect from 'tom-select';

const ColorTable = {
    red: '#fe4444',
    green: '#42da57',
    blue: '#39a1f3',
    grey: '#999999',
};

type Coordinate = {
    x: number;
    y: number;
};

const DZOOM = 0.1;
const MINZOOM = 0.1;

export class Cfg extends Pane<CfgState> {
    graphDiv: HTMLElement;
    canvas: HTMLCanvasElement;
    blockContainer: HTMLElement;
    graphContainer: HTMLElement;
    graphElement: HTMLElement;
    currentPosition: Coordinate = {x: 0, y: 0};
    dragging = false;
    dragStart: Coordinate = {x: 0, y: 0};
    dragStartPosition: Coordinate = {x: 0, y: 0};
    zoom = 1;
    graphDimensions = {width: 0, height: 0};
    functionSelector: TomSelect;
    results: CFGResult;
    state: CfgState & PaneState;
    constructor(hub: Hub, container: Container, state: CfgState & PaneState) {
        super(hub, container, state);
        this.eventHub.emit('cfgViewOpened', this.compilerInfo.compilerId);
        this.eventHub.emit('requestFilters', this.compilerInfo.compilerId);
        this.eventHub.emit('requestCompiler', this.compilerInfo.compilerId);
        const selector = this.domRoot.get()[0].getElementsByClassName('function-selector')[0];
        if (!(selector instanceof HTMLSelectElement)) {
            throw new Error('.function-selector is not an HTMLSelectElement');
        }
        this.functionSelector = new TomSelect(selector, {
            valueField: 'value',
            labelField: 'title',
            searchField: ['title'],
            dropdownParent: 'body',
            plugins: ['input_autogrow'],
            sortField: 'title',
            onChange: e => {
                this.selectFunction(e as any as string);
            },
        });
        this.state = state;
    }
    override getInitialHTML() {
        return $('#cfg').html();
    }
    override getDefaultPaneName() {
        return 'CFG';
    }
    override registerOpeningAnalyticsEvent(): void {
        ga.proxy('send', {
            hitType: 'event',
            eventCategory: 'OpenViewPane',
            eventAction: 'CFGViewPane',
        });
    }
    override registerDynamicElements(state: CfgState) {
        this.graphDiv = this.domRoot.find('.graph')[0];
        this.canvas = this.domRoot.find('canvas')[0] as HTMLCanvasElement;
        this.blockContainer = this.domRoot.find('.block-container')[0];
        this.graphContainer = this.domRoot.find('.graph-container')[0];
        this.graphElement = this.domRoot.find('.graph')[0];
    }
    override registerCallbacks() {
        this.graphContainer.addEventListener('mousedown', e => {
            const div = (e.target as Element).closest('div');
            if (div && div.classList.contains('block')) {
                // pass, let the user select block contents
            } else {
                this.dragging = true;
                this.dragStart = {x: e.clientX, y: e.clientY};
                this.dragStartPosition = {...this.currentPosition};
            }
        });
        this.graphContainer.addEventListener('mouseup', e => {
            this.dragging = false;
        });
        this.graphContainer.addEventListener('mousemove', e => {
            if (this.dragging) {
                this.currentPosition = {
                    x: e.clientX - this.dragStart.x + this.dragStartPosition.x,
                    y: e.clientY - this.dragStart.y + this.dragStartPosition.y,
                };
                this.graphElement.style.left = this.currentPosition.x + 'px';
                this.graphElement.style.top = this.currentPosition.y + 'px';
            }
        });
        this.graphContainer.addEventListener('wheel', e => {
            const delta = DZOOM * -Math.sign(e.deltaY);
            this.zoom += delta;
            if (this.zoom >= MINZOOM) {
                this.graphElement.style.transform = `scale(${this.zoom})`;
                const mouseX = e.clientX - this.graphElement.getBoundingClientRect().x;
                const mouseY = e.clientY - this.graphElement.getBoundingClientRect().y;
                // Amount that the zoom will offset is mouseX / width before zoom * delta * unzoomed width
                // And same for y. The width / height terms cancel.
                this.currentPosition.x -= (mouseX / (this.zoom - delta)) * delta;
                this.currentPosition.y -= (mouseY / (this.zoom - delta)) * delta;
                this.graphElement.style.left = this.currentPosition.x + 'px';
                this.graphElement.style.top = this.currentPosition.y + 'px';
            } else {
                this.zoom = MINZOOM;
            }
        });
    }
    override onCompiler(compilerId: number, compiler: any, options: unknown, editorId: number, treeId: number): void {
        if (this.compilerInfo.compilerId !== compilerId) return;
        this.compilerInfo.compilerName = compiler ? compiler.name : '';
        this.compilerInfo.editorId = editorId;
        this.compilerInfo.treeId = treeId;
        this.updateTitle();
        if (compiler && !compiler.supportsLLVMOptPipelineView) {
            //this.editor.setValue('<LLVM IR output is not supported for this compiler>');
        }
    }
    override onCompileResult(compilerId: number, compiler: any, result: any) {
        if (this.compilerInfo.compilerId !== compilerId) return;
        //console.log(result);
        if (result.cfg) {
            const cfg = result.cfg as CFGResult;
            this.results = cfg;
            let selectedFunction = this.state.selectedFunction;
            this.functionSelector.clear();
            this.functionSelector.clearOptions();
            const keys = Object.keys(cfg);
            if (keys.length === 0) {
                this.functionSelector.addOption({
                    title: '<No functions available>',
                    value: '<No functions available>',
                });
            }
            for (const fn of keys) {
                this.functionSelector.addOption({
                    title: fn,
                    value: fn,
                });
            }
            if (keys.length > 0) {
                if (selectedFunction === '' || !(selectedFunction in cfg)) {
                    selectedFunction = keys[0];
                }
                this.functionSelector.setValue(selectedFunction);
            } else {
                // restore this.selectedFunction, next time the compilation results aren't errors the selected function will
                // still be the same
                this.state.selectedFunction = selectedFunction;
            }
            this.selectFunction(this.state.selectedFunction);
        }
    }
    async selectFunction(name: string) {
        const fn = this.results[name];
        this.blockContainer.innerHTML = '';
        for (const node of fn.nodes) {
            this.blockContainer.innerHTML += `<div class="block" data-bb-id="${node.id}">${await monaco.editor.colorize(
                node.label,
                'asm',
                MonacoConfig.extendConfig({})
            )}</div>`;
        }
        for (const node of fn.nodes) {
            //const elem = $(this.blockContainer).find(`.block[data-bb-id="${node.id}"]`)[0];
            //(node as AnnotatedNodeDescriptor).width = elem.getBoundingClientRect().width;
            //(node as AnnotatedNodeDescriptor).height = elem.getBoundingClientRect().height;
            const elem = $(this.blockContainer).find(`.block[data-bb-id="${node.id}"]`);
            void elem[0].offsetHeight;
            (node as AnnotatedNodeDescriptor).width = elem.outerWidth() as number;
            (node as AnnotatedNodeDescriptor).height = elem.outerHeight() as number;
            //console.log(elem, elem.outerWidth(), elem.outerHeight(), elem[0].offsetHeight,  node);
        }
        //console.log("test");
        //console.log(fn.nodes);
        const x = new GraphLayoutCore(fn as AnnotatedCfgDescriptor);
        this.graphDimensions.width = x.getWidth();
        this.graphDimensions.height = x.getHeight();
        this.graphDiv.style.height = x.getHeight() + 'px';
        this.graphDiv.style.width = x.getWidth() + 'px';
        this.canvas.style.height = x.getHeight() + 'px';
        this.canvas.style.width = x.getWidth() + 'px';
        this.canvas.height = x.getHeight();
        this.canvas.width = x.getWidth();
        this.blockContainer.style.height = x.getHeight() + 'px';
        this.blockContainer.style.width = x.getWidth() + 'px';
        const ctx = this.canvas.getContext('2d');
        if (!ctx) {
            throw Error('foobar');
        }
        ctx.lineWidth = 2;
        //ctx.strokeStyle = "#ffffff";
        //ctx.fillStyle = "#ffffff";
        for (const block of x.blocks) {
            const elem = $(this.blockContainer).find(`.block[data-bb-id="${block.data.id}"]`)[0];
            elem.style.top = block.coordinates.y + 'px';
            elem.style.left = block.coordinates.x + 'px';
            for (const edge of block.edges) {
                ctx.strokeStyle = ColorTable[edge.color];
                ctx.fillStyle = ColorTable[edge.color];
                ctx.beginPath();
                for (const segment of edge.path) {
                    ctx.moveTo(segment.start.x, segment.start.y);
                    ctx.lineTo(segment.end.x, segment.end.y);
                }
                //ctx.moveTo(edge.path[0].x, edge.path[0].y);
                //for(const pathPoint of edge.path.slice(1)) {
                //    ctx.lineTo(pathPoint.x, pathPoint.y);
                //}
                ctx.stroke();
                const endpoint = edge.path[edge.path.length - 1].end;
                const triangleHeight = 7;
                const triangleWidth = 7;
                ctx.beginPath();
                ctx.moveTo(endpoint.x - triangleWidth / 2, endpoint.y - triangleHeight);
                ctx.lineTo(endpoint.x + triangleWidth / 2, endpoint.y - triangleHeight);
                ctx.lineTo(endpoint.x, endpoint.y);
                ctx.lineTo(endpoint.x - triangleWidth / 2, endpoint.y - triangleHeight);
                ctx.lineTo(endpoint.x + triangleWidth / 2, endpoint.y - triangleHeight);
                ctx.fill();
                //ctx.stroke();
                //ctx.fillRect(edge.path[edge.path.length - 1].x - 5, edge.path[edge.path.length - 1].y - 5, 10, 10);
            }
        }
        //ctx.strokeStyle = "red";
        //for(const blockRow of x.blockRows) {
        //    ctx.strokeRect(0, blockRow.totalOffset, 100, blockRow.height);
        //}
        //for(const blockRow of x.blockColumns) {
        //    ctx.strokeRect(blockRow.totalOffset, 0, blockRow.width, 100);
        //}
    }
    override resize() {
        //const topBarHeight = this.topBar.outerHeight(true) as number;
        //this.editor.layout({
        //    width: this.domRoot.width() as number,
        //    height: (this.domRoot.height() as number) - topBarHeight,
        //});
    }
    override close(): void {
        this.eventHub.unsubscribe();
        this.eventHub.emit('cfgViewClosed', this.compilerInfo.compilerId);
    }
}
