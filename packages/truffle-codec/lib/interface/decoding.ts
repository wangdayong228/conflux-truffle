import debugModule from "debug";
const debug = debugModule("codec:interface");

import { AstDefinition, Types, Values } from "truffle-codec-utils";
import * as CodecUtils from "truffle-codec-utils";
import * as Pointer from "../types/pointer";
import { EvmInfo } from "../types/evm";
import { DecoderRequest, GeneratorJunk } from "../types/request";
import { CalldataAllocation, EventAllocation, EventArgumentAllocation } from "../types/allocation";
import { CalldataDecoding, EventDecoding, AbiArgument } from "../types/wire";
import { encodeTupleAbi } from "../encode/abi";
import read from "../read";
import decode from "../decode";

export function* decodeVariable(definition: AstDefinition, pointer: Pointer.DataPointer, info: EvmInfo): IterableIterator<Values.Result | DecoderRequest | GeneratorJunk> {
  let compiler = info.currentContext.compiler;
  let dataType = Types.definitionToType(definition, compiler);
  debug("definition %O", definition);
  return yield* decode(dataType, pointer, info); //no need to pass an offset
}

export function* decodeCalldata(info: EvmInfo): IterableIterator<CalldataDecoding | DecoderRequest | Values.Result | GeneratorJunk> {
  const context = info.currentContext;
  if(context === null) {
    //if we don't know the contract ID, we can't decode
    return {
      kind: "unknown"
    }
  }
  const compiler = info.currentContext.compiler;
  const contractId = context.contractId;
  const contractType = CodecUtils.Contexts.contextToType(context);
  const allocations = info.allocations.calldata[contractId];
  let allocation: CalldataAllocation;
  let isConstructor: boolean = info.currentContext.isConstructor;
  //first: is this a creation call?
  if(isConstructor) {
    allocation = allocations.constructorAllocation;
  }
  else {
    //skipping any error-handling on this read, as a calldata read can't throw anyway
    let rawSelector = <Uint8Array> read(
      { location: "calldata",
        start: 0,
        length: CodecUtils.EVM.SELECTOR_SIZE
      },
      info.state
    ).next().value; //no requests should occur, we can just get the first value
    let selector = CodecUtils.Conversion.toHexString(rawSelector);
    allocation = allocations.functionAllocations[selector];
  }
  if(allocation === undefined) {
    return {
      kind: "fallback",
      class: contractType
    };
  }
  //you can't map with a generator, so we have to do this map manually
  let decodedArguments: AbiArgument[] = [];
  for(const argumentAllocation of allocation.arguments) {
    const value = <Values.Result> (yield* decode(
      Types.definitionToType(argumentAllocation.definition, compiler),
      argumentAllocation.pointer,
      info,
      allocation.offset //note the use of the offset for decoding pointers!
    ));
    const name = argumentAllocation.definition.name;
    decodedArguments.push(
      name === undefined
        ? { value }
        : { name, value }
    );
  }
  if(isConstructor) {
    return {
      kind: "constructor",
      class: contractType,
      arguments: decodedArguments
    };
  }
  else {
    return {
      kind: "function",
      class: contractType,
      name: allocation.definition.name,
      arguments: decodedArguments
    };
  }
}

export function* decodeEvent(info: EvmInfo): IterableIterator<EventDecoding[] | DecoderRequest | Values.Result | GeneratorJunk> {
  const compiler = info.currentContext.compiler;
  const allocations = info.allocations.event;
  let rawSelector: Uint8Array;
  try {
    rawSelector = <Uint8Array> read(
      { location: "eventtopic",
        topic: 0
      },
      info.state
    ).next().value; //no requests should occur, we can just get the first value
  }
  catch(error) {
    //if we can't read the selector, return an empty set of decodings
    return [];
  }
  const selector = CodecUtils.Conversion.toHexString(rawSelector);
  const topicsCount = info.state.eventtopics.length;
  //yeah, it's not great to read directly from the state like this (bypassing read), but what are you gonna do?
  const { contract: contractAllocations, library: libraryAllocations } = allocations[selector][topicsCount];
  //we only want one contract from the contractAllocations -- this one
  const contractId = info.currentContext.contractId;
  const contractAllocation = contractAllocations[contractId];
  const possibleAllocations: [string, EventAllocation][] = [[contractId.toString(), contractAllocation], ...Object.entries(libraryAllocations)];
  //should be number, but we have to temporarily pass through string to get compilation to work...
  let decodings: EventDecoding[] = [];
  for(const [id, allocation] of possibleAllocations) {
    try {
      const context = info.contexts[parseInt(id)];
      const contractType = CodecUtils.Contexts.contextToType(context);
      const newInfo = { ...info, currentContext: context };
      //you can't map with a generator, so we have to do this map manually
      let decodedArguments: AbiArgument[] = [];
      for(const argumentAllocation of allocation.arguments) {
        const value = <Values.Result> (yield* decode(
          Types.definitionToType(argumentAllocation.definition, compiler),
          argumentAllocation.pointer,
          newInfo,
          0, //offset is always 0 for events
          true //turns on STRICT MODE to cause more errors to be thrown
        ));
        const name = argumentAllocation.definition.name;
        decodedArguments.push(
          name === undefined
            ? { value }
            : { name, value }
        );
      }
      //OK, so, having decoded the result, the question is: does it reencode to the original?
      //first, we have to filter out the indexed arguments, and also get rid of the name information
      const nonIndexedValues = decodedArguments.filter(
        (_, index) => allocation.arguments[index].pointer.location !== "eventtopic"
      ).map(
        ({value}) => value
      );
      //now, we can encode!
      const reEncodedData = encodeTupleAbi(nonIndexedValues, info.allocations.abi);
      //are they equal?
      const encodedData = info.state.eventdata; //again, not great to read this directly, but oh well
      if(CodecUtils.EVM.equalData(encodedData, reEncodedData)) {
        decodings.push({
          kind: "event",
          class: contractType,
          name: allocation.definition.name,
          arguments: decodedArguments
        });
      }
      //otherwise, just move on
    }
    catch(error) {
      continue; //if an error occurred, this isn't a valid decoding!
    }
  }
  return decodings;
}