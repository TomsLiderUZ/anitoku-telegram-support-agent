import { Link } from 'react-router-dom';
import { FiCompass } from 'react-icons/fi';
import { Empty, PageHead } from '../components/Ui';

export default function NotFound() {
  return (
    <>
      <PageHead title="Sahifa topilmadi" />
      <div className="card">
        <Empty icon={FiCompass}>
          Bunday sahifa yoʻq. <Link to="/">Boshqaruvga qaytish</Link>
        </Empty>
      </div>
    </>
  );
}
