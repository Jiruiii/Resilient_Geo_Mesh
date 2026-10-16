import unittest
from tools.validation.sample_battery import parse_battery, summarize


class BatterySamplerTests(unittest.TestCase):
    def test_usb_and_missing_fields_never_become_discharge_evidence(self):
        charging = parse_battery('USB powered: true\nstatus: 2\nCharge counter: 12345\nlevel: 50')
        self.assertTrue(charging['plugged'])
        self.assertFalse(summarize([charging, charging])['discharge_counter_usable'])
        self.assertIsNone(parse_battery('level: 50')['plugged'])
        self.assertIsNone(parse_battery('level: 50')['charge_uah'])

    def test_only_real_discharging_counter_delta_is_reported(self):
        def sample(charge):
            return parse_battery(f'AC powered: false\nUSB powered: false\nWireless powered: false\nstatus: 3\nCharge counter: {charge}')
        self.assertEqual(summarize([sample(10000), sample(9000)])['charge_used_uah'], 1000)
        self.assertIsNone(summarize([sample(9000), sample(10000)])['charge_used_uah'])
        self.assertIsNone(summarize([sample(10000)])['charge_used_uah'])


if __name__ == '__main__':
    unittest.main()
