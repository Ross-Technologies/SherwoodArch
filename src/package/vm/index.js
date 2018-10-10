const fs = require("fs");
const Mailbox = require("./hardware/mailbox");
const RTC = require("./hardware/rtc");
const UART = require("./hardware/uart");

const CPU_REG_FLAG_INTR = (1 << 0);

const CPU_INT = {
	"STACK_OVERFLOW": 0,
	"FAULT": 1,
	"BADADDR": 2,
	"DIVBYZERO": 3,
	"BADINSTR": 4,
	"TIMER": 5
};

const IO_RAM_BASE = 0xA0000000;
const IO_RAM_SIZE = 0x40000000;
const IO_RAM_END = IO_RAM_BASE+IO_RAM_SIZE;

function setupRegisters() {
	return {
		flags: new Float64Array(1),
		tmp: new Float64Array(1),
		sp: new Float64Array(1),
		ip: new Float64Array(1),
		pc: new Float64Array(1),
		cycle: new Float64Array(1),
		data: new Float64Array(10),
		index: new Float64Array(10),
		addr: new Float64Array(10),
		ptr: new Float64Array(10)
	};
}

class VirtualMachine {
	constructor(opts = {}) {
		this.cpu = {
			regs: setupRegisters(),
			iregs: setupRegisters(),
			
			stack: new Float64Array(20),
			ivt: new Float64Array(6),
			intr: new Float64Array(1),
			running: false
		};
		this.ioctl = {
			ram: new Float64Array(IO_RAM_SIZE),
			mmap: []
		};
		this.opts = opts;
		
		this.mailbox = new Mailbox();
		this.rtc = new RTC();
		this.uart = new UART();
	}
	destroy() {
		if(this.mailbox) this.mailbox.destroy(this);
		if(this.rtc) this.rtc.destroy(this);
		if(this.uart) this.uart.destroy(this);
	}
	reset() {
		/* (Re)initialize the RAM */
		if(this.ioctl.ram) delete this.ioctl.ram;
		this.ioctl.ram = new Float64Array(IO_RAM_SIZE);
		
		/* (Re)initialize the memory map in the IO Controller */
		if(this.ioctl.mmap) delete this.ioctl.mmap;
		this.ioctl.mmap = [];
		this.mmap(IO_RAM_BASE,IO_RAM_END,i => this.ioctl.ram[i],(i,v) => { this.ioctl.ram[i] = v; });
		
		/* Reset the mailbox */
		if(this.mailbox) this.mailbox.reset(this);
		
		/* Reset the RTC */
		if(this.rtc) this.rtc.reset(this);
		
		/* Reset the UART */
		if(this.uart) this.uart.reset(this);
		
		/* Reset the registers */
		this.cpu.regs = this.cpu.iregs = setupRegisters();
		
		/* Reset the CPU */
		this.cpu.stack.fill(0);
		this.cpu.ivt.fill(0);
		this.cpu.intr[0] = 0;
		this.cpu.running = false;
	}
	
	intr(i) {
		if(i > this.cpu.ivt.length) throw new Error("SAVM_ERROR_INVAL_INT");
		if(this.cpu.regs.flags[0] & CPU_REG_FLAG_INTR) {
			this.cpu.intr[0] = CPU_INT["FAULT"];
			return;
		}
		this.cpu.iregs = this.cpu.regs;
		this.cpu.regs.flags[0] |= CPU_REG_FLAG_INTR;
		this.cpu.intr[0] = i;
		this.cpu.regs.pc[0] = this.cpu.ivt[i];
	}
	regread(i) {
		switch(i) {
			case 0: /* flags */ return this.cpu.regs.flags[0];
			case 1: /* tmp */ return this.cpu.regs.tmp[0];
			case 2: /* sp */ return this.cpu.regs.sp[0];
			case 3: /* ip */ return this.cpu.regs.ip[0];
			case 4: /* pc */ return this.cpu.regs.pc[0];
			case 5: /* cycle */ return this.cpu.regs.cycle[0];
			default:
				if(i >= 6 && i < 16) return this.cpu.regs.data[i-6];
				if(i >= 17 && i < 27) return this.cpu.regs.index[i-17];
				if(i >= 28 && i < 38) return this.cpu.regs.addr[i-28];
				if(i >= 39 && i < 49) return this.cpu.regs.ptr[i-39];
				throw new Error("SAVM_ERROR_INVAL_ADDR");
		}
	}
	regwrite(i,v) {
		switch(i) {
			case 0: /* flags */
				this.cpu.regs.flags[0] = v;
				break;
			case 1: /* tmp */
				this.cpu.regs.tmp[0] = v;
				break;
			case 2: /* sp */
				this.cpu.regs.sp[0] = v;
				break;
			case 3: /* ip */
				this.cpu.regs.ip[0] = v;
				break;
			case 4: /* pc */
				this.cpu.regs.pc[0] = v;
				break;
			case 5: /* cycle */
				this.cpu.regs.cycle[0] = v;
				break;
			default:
				if(i >= 6 && i < 16) {
					this.cpu.regs.data[i-6] = v;
					break;
				}
				if(i >= 17 && i < 27) {
					this.cpu.regs.index[i-17] = v;
					break;
				}
				if(i >= 28 && i < 38) {
					this.cpu.regs.addr[i-28] = v;
					break;
				}
				if(i >= 39 && i < 49) {
					this.cpu.regs.ptr[i-39] = v;
					break;
				}
				throw new Error("SAVM_ERROR_INVAL_ADDR");
		}
	}
	cycle() {
		if(this.cpu.regs.pc[0] == 0) this.cpu.regs.pc[0] = IO_RAM_BASE+(this.cpu.regs.cycle[0]*3);
		
		/* Fetches the instruction from memory */
		this.cpu.regs.ip[0] = this.read(this.cpu.regs.pc[0]);
		
		/* Decodes the instruction */
		var addr = this.read(this.cpu.regs.pc[0]+1);
		var val = this.read(this.cpu.regs.pc[0]+2);
		
		this.cpu.regs.pc[0] += 3;
		
		/* Execute the instruction */
		try {
			switch(this.cpu.regs.ip[0]) {
				case 0: /* NOP */
					this.cpu.running = false;
					break;
				case 1: /* ADDR */
					this.regwrite(addr,this.regread(addr)+this.regread(val));
					break;
				case 2: /* ADDM */
					this.write(addr,this.read(addr)+this.read(val));
					break;
				case 3: /* SUBR */
					this.regwrite(addr,this.regread(addr)-this.regread(val));
					break;
				case 4: /* SUBM */
					this.write(addr,this.read(addr)-this.read(val));
					break;
				case 5: /* MULR */
					this.regwrite(addr,this.regread(addr)*this.regread(val));
					break;
				case 6: /* MULM */
					this.write(addr,this.read(addr)*this.read(val));
					break;
				case 7: /* DIVR */
					if(this.regread(val) == 0) {
						this.intr(CPU_INT["DIVBYZERO"]);
						break;
					}
					this.regwrite(addr,this.regread(addr)/this.regread(val));
					break;
				case 8: /* DIVM */
					if(this.read(val) == 0) {
						this.intr(CPU_INT["DIVBYZERO"]);
						break;
					}
					this.write(addr,this.read(addr)/this.read(val));
					break;
				case 9: /* ANDR */
					this.regwrite(addr,this.regread(addr) & this.regread(val));
					break;
				case 10: /* ANDM */
					this.write(addr,this.read(addr) & this.read(val));
					break;
				case 11: /* ORR */
					this.regwrite(addr,this.regread(addr) | this.regread(val));
					break;
				case 12: /* ORM */
					this.write(addr,this.read(addr) | this.read(val));
					break;
				case 13: /* XORR */
					this.regwrite(addr,this.regread(addr) ^ this.regread(val));
					break;
				case 14: /* XORM */
					this.write(addr,this.read(addr) ^ this.read(val));
					break;
				case 15: /* NORR */
					this.regwrite(addr,~(this.regread(addr) | this.regread(val)));
					break;
				case 16: /* NORM */
					this.write(addr,~(this.read(addr) | this.read(val)));
					break;
				case 17: /* NANDR */
					this.regwrite(addr,~(this.regread(addr) & this.regread(val)));
					break;
				case 18: /* NANDM */
					this.write(addr,~(this.read(addr) & this.read(val)));
					break;
				case 19: /* LSHIFTR */
					this.regwrite(addr,this.regread(addr) << this.regread(val));
					break;
				case 20: /* LSHIFTM */
					this.write(addr,this.read(addr) << this.read(val));
					break;
				case 21: /* RSHIFTR */
					this.regwrite(addr,this.regread(addr) >> this.regread(val));
					break;
				case 22: /* RSHIFTM */
					this.write(addr,this.read(addr) >> this.read(val));
					break;
				case 23: /* CMPR */
					this.cpu.regs.tmp[0] = this.regread(addr) == this.regread(val);
					break;
				case 24: /* CMPM */
					this.cpu.regs.tmp[0] = this.read(addr) == this.read(val);
					break;
				case 25: /* JITR */
					if(this.cpu.regs.tmp[0]) this.cpu.regs.pc[0] = this.regread(addr);
					break;
				case 26: /* JITM */
					if(this.cpu.regs.tmp[0]) this.cpu.regs.pc[0] = this.read(addr);
					break;
				case 27: /* JIT */
					if(this.cpu.regs.tmp[0]) this.cpu.regs.pc[0] = addr;
					break;
				case 28: /* JMPR */
					this.cpu.regs.pc[0] = this.regread(addr);
					break;
				case 29: /* JMPM */
					this.cpu.regs.pc[0] = this.read(addr);
					break;
				case 30: /* JMP */
					this.cpu.regs.pc[0] = addr;
					break;
				case 31: /* CALLR */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) {
						this.cpu.stack[this.cpu.regs.sp[0]++] = this.cpu.regs.pc[0];
						this.cpu.regs.pc[0] = this.regread(addr);
					} else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 32: /* CALLM */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) {
						this.cpu.stack[this.cpu.regs.sp[0]++] = this.cpu.regs.pc[0];
						this.cpu.regs.pc[0] = this.read(addr);
					} else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 33: /* CALL */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) {
						this.cpu.stack[this.cpu.regs.sp[0]++] = this.cpu.regs.pc[0];
						this.cpu.regs.pc[0] = addr;
					} else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 34: /* RET */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) this.cpu.regs.pc[0] = this.cpu.stack[this.cpu.regs.sp[0]--];
					else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 35: /* PUSHR */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) this.cpu.stack[this.cpu.regs.sp[0]++] = this.regread(addr);
					else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 36: /* PUSHM */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) this.cpu.stack[this.cpu.regs.sp[0]++] = this.read(addr);
					else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 37: /* POPR */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) this.regwrite(addr,this.cpu.stack[this.cpu.regs.sp[0]--]);
					else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 38: /* POPM */
					if(this.cpu.regs.sp[0] < this.cpu.stack.length) this.write(addr,this.cpu.stack[this.cpu.regs.sp[0]--]);
					else this.intr(CPU_INTR["STACK_OVERFLOW"]);
					break;
				case 39: /* MOVRR */
					this.regwrite(addr,this.regread(val));
					break;
				case 40: /* MOVRM */
					this.write(addr,this.regread(val));
					break;
				case 41: /* MOVMR */
					this.regwrite(addr,this.read(val));
					break;
				case 42: /* MOVMM */
					this.write(addr,this.read(val));
					break;
				case 43: /* STOR */
					this.regwrite(addr,val);
					break;
				case 44: /* STOM */
					this.write(addr,val);
					break;
				case 45: /* INTR */
					var a = this.regread(addr);
					try {
						this.intr(a);
					} catch(ex) {
						this.intr(CPU_INTR["BADADDR"]);
					}
					break;
				case 46: /* INTM */
					var a = this.read(addr);
					try {
						this.intr(a);
					} catch(ex) {
						this.intr(CPU_INTR["BADADDR"]);
					}
					break;
				case 47: /* INT */
					try {
						this.intr(addr);
					} catch(ex) {
						this.intr(CPU_INTR["BADADDR"]);
					}
					break;
				case 48: /* IRET */
					if(this.cpu.regs.flags[0] & CPU_REG_FLAG_INTR) this.cpu.regs = this.cpu.iregs;
					else this.intr(CPU_INTR["FAULT"]);
					break;
				case 49: /* LDITBLR */
					addr = this.regread(addr);
					for(var i = 0;i < this.cpu.ivt.length;i++) this.cpu.ivt[i] = this.read(addr+i);
					break;
				case 50: /* LDITBLM */
					addr = this.read(addr);
					for(var i = 0;i < this.cpu.ivt.length;i++) this.cpu.ivt[i] = this.read(addr+i);
					break;
				case 51: /* HLT */
					this.cpu.running = false;
					break;
				default:
					this.intr(CPU_INTR["BADINSTR"]);
			}
		} catch(ex) {
			if(ex.message == "SAVM_ERROR_NOTMAPPED") this.intr(CPU_INTR["BADADDR"]);
			else throw ex;
		}
		
		if(this.rtc) this.rtc.cycle(this);
		if(this.mailbox) this.mailbox.cycle(this);
		if(this.uart) this.uart.cycle(this);
		
		this.cpu.regs.cycle[0]++;
	}
	
	loadFile(addr,path) {
		var buff = new Float64Array(fs.readFileSync(path));
		for(var i = 0;i < buff.length;i++) this.write(addr,buff[i]);
	}
	dumpFile(addr,size,path) {
		var buff = new Float64Array(size);
		for(var i = 0;i < buff.length;i++) buff[i] = this.read(i);
		fs.writeFileSync(path,buff);
	}
	mmap(addr,end,read = () => 0,write = () => {}) {
		for(var entry of this.ioctl.mmap) {
			if(entry.addr == addr && entry.end == end) throw new Error("SAVM_ERROR_MAPPED");
		}
		this.ioctl.mmap.push({
			addr: addr,
			end: end,
			read: read,
			write: write
		});
	}
	read(addr) {
		for(var entry of this.ioctl.mmap) {
			if(entry.addr <= addr && entry.end > addr) return entry.read(addr-entry.addr);
		}
		throw new Error("SAVM_ERROR_NOTMAPPED");
	}
	write(addr,v) {
		for(var entry of this.ioctl.mmap) {
			if(entry.addr <= addr && entry.end > addr) return entry.write(addr-entry.addr,v);
		}
		throw new Error("SAVM_ERROR_NOTMAPPED");
	}
}

module.exports = VirtualMachine;
